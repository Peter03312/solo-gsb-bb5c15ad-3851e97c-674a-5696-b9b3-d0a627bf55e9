import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { DischargeSimulation } from './discharge';
import { evaluatePort } from './berth';

/* ---------- DTO ---------- */

export interface CreateBerthBookingInput {
  dischargePort: string;
  berth: string;
  /** 带时区的起始时刻（ISO 8601，服务层已校验含偏移且可解析） */
  startAt: string;
  /** 带时区的结束时刻（ISO 8601），必须严格晚于 startAt */
  endAt: string;
  /** 同一审查内唯一的提交号（幂等键） */
  submissionNo: string;
}

interface ReviewRow {
  id: string;
  voyage_id: string;
  manifest_rev: number;
  result_jsonb: DischargeSimulation;
}

interface BookingRow {
  id: string;
  review_id: string;
  voyage_id: string;
  manifest_rev: number;
  discharge_port: string;
  berth: string;
  start_at: Date;
  end_at: Date;
  submission_no: string;
  discharged_box_count: number;
  status: 'active' | 'cancelled';
  created_at: Date;
  cancelled_at: Date | null;
  request_hash: string;
}

/* ---------- 提交内容指纹（同号重试判定同内容/改内容） ---------- */

/**
 * 规范化为绝对时刻（epoch 毫秒）后哈希：同一时间点无论用何种 UTC 偏移书写，
 * 只要卸港/泊位/起止时刻相同即为“同内容”。
 */
function hashBookingRequest(
  input: CreateBerthBookingInput,
  start: Date,
  end: Date,
): string {
  const canonical = JSON.stringify({
    dischargePort: input.dischargePort,
    berth: input.berth,
    startEpochMs: start.getTime(),
    endEpochMs: end.getTime(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- 读取辅助 ---------- */

const BOOKING_COLUMNS = `id, review_id, voyage_id, manifest_rev, discharge_port, berth,
  start_at, end_at, submission_no, discharged_box_count, status, created_at, cancelled_at, request_hash`;

async function loadReview(
  client: PoolClient,
  reviewId: string,
): Promise<ReviewRow | null> {
  const res = await client.query(
    `SELECT id, voyage_id, manifest_rev, result_jsonb
     FROM discharge_reviews WHERE id=$1`,
    [reviewId],
  );
  return (res.rows[0] as ReviewRow | undefined) ?? null;
}

function bookingToJson(row: BookingRow) {
  return {
    bookingId: row.id,
    reviewId: row.review_id,
    voyageId: row.voyage_id,
    // 受理时冻结的清单修订号（航次后续调整或签发新清单不回写）
    frozenManifestRevision: row.manifest_rev,
    manifestRevision: row.manifest_rev,
    dischargePort: row.discharge_port,
    berth: row.berth,
    // 绝对时刻以 UTC（带 Z 时区标识）返回
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    submissionNo: row.submission_no,
    // 受理时冻结的该港实际卸箱数（不回写）
    dischargedBoxCount: row.discharged_box_count,
    status: row.status,
    active: row.status === 'active',
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    requestHash: row.request_hash,
  };
}

/** 把数据库约束冲突翻译为明确的业务错误（并发竞争的最终裁决点） */
function mapInsertError(
  err: { code?: string; constraint?: string },
  input: CreateBerthBookingInput,
  start: Date,
  end: Date,
): HttpError {
  if (err.constraint === 'berth_bookings_no_overlap' || err.code === '23P01') {
    return HttpError.conflict(
      'berth_window_overlap',
      `卸港 ${input.dischargePort} 泊位 ${input.berth} 在该时间段已有有效靠泊窗口（首尾相接可用，重叠不可）`,
      {
        dischargePort: input.dischargePort,
        berth: input.berth,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      },
    );
  }
  if (err.constraint === 'uq_berth_bookings_one_active_per_review_port') {
    return HttpError.conflict(
      'active_booking_exists',
      `该审查在卸港 ${input.dischargePort} 已有有效预订，同一审查同一卸港至多一个有效预订`,
      { dischargePort: input.dischargePort },
    );
  }
  if (err.constraint === 'berth_bookings_review_id_submission_no_key' || err.code === '23505') {
    return HttpError.conflict(
      'submission_no_conflict',
      `提交号 ${input.submissionNo} 在该审查内已被使用，提交号唯一且不可复用；重新预订请改用新提交号`,
      { submissionNo: input.submissionNo },
    );
  }
  return HttpError.conflict('booking_conflict', '靠泊窗口预订冲突');
}

/* ---------- 服务 ---------- */

export class BerthBookingService {
  constructor(private readonly pool: Pool) {}

  /**
   * 依据已留档的卸货审查预订靠泊窗口。
   *
   *  - 审查未知 -> 404 discharge_review_not_found；
   *  - 起点不早于终点 -> 409 invalid_time_range；
   *  - 同提交号已存在：同内容（同样的卸港/泊位/起止绝对时刻）-> 200 replay:true，
   *    返回原预订【当前状态】（可能已取消）；改内容 -> 409 submission_no_conflict；
   *  - 卸港不在审查港序列表 -> 404 unknown_discharge_port；
   *  - 该港无实际卸箱或存在受阻箱 -> 422 port_not_dischargeable；
   *  - 同审查同卸港已有有效预订 -> 409 active_booking_exists；
   *  - 同港同泊位窗口重叠（即使来自不同航次）-> 409 berth_window_overlap；首尾相接允许。
   *
   * 受理后冻结清单修订号与该港实际卸箱数；后续调整或签发新清单不回写。
   */
  async createBooking(
    reviewId: string,
    input: CreateBerthBookingInput,
  ): Promise<{ replay: boolean; booking: ReturnType<typeof bookingToJson> }> {
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    const requestHash = hashBookingRequest(input, start, end);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const review = await loadReview(client, reviewId);
      if (!review) {
        throw HttpError.notFound('discharge_review_not_found', `卸货审查 ${reviewId} 不存在，无法预订靠泊窗口`);
      }

      // 起点必须严格早于终点（zod 已保证可解析且带时区）
      if (!(start.getTime() < end.getTime())) {
        throw HttpError.conflict(
          'invalid_time_range',
          `非法时刻区间：起点 ${input.startAt} 必须严格早于终点 ${input.endAt}`,
          { startAt: input.startAt, endAt: input.endAt },
        );
      }

      // 提交号幂等/冲突判定优先（同号同内容即使在取消后也返回原预订当前状态）
      const existingRes = await client.query(
        `SELECT ${BOOKING_COLUMNS} FROM berth_bookings WHERE review_id=$1 AND submission_no=$2`,
        [reviewId, input.submissionNo],
      );
      if (existingRes.rows.length === 1) {
        const existing = existingRes.rows[0] as BookingRow;
        if (existing.request_hash !== requestHash) {
          throw HttpError.conflict(
            'submission_no_conflict',
            `提交号 ${input.submissionNo} 在该审查内已用于不同内容，提交号唯一且不可复用；重新预订请改用新提交号`,
            {
              submissionNo: input.submissionNo,
              stored: {
                dischargePort: existing.discharge_port,
                berth: existing.berth,
                startAt: existing.start_at.toISOString(),
                endAt: existing.end_at.toISOString(),
                status: existing.status,
              },
              incoming: {
                dischargePort: input.dischargePort,
                berth: input.berth,
                startAt: start.toISOString(),
                endAt: end.toISOString(),
              },
            },
          );
        }
        await client.query('COMMIT');
        return { replay: true, booking: bookingToJson(existing) };
      }

      // 受理条件：该港在【冻结模拟结果】中有实际卸箱且无受阻箱
      const eligibility = evaluatePort(review.result_jsonb, input.dischargePort);
      if (!eligibility.known) {
        throw HttpError.notFound(
          'unknown_discharge_port',
          `卸港 ${input.dischargePort} 不在审查 ${reviewId} 的卸港列表中`,
          {
            dischargePort: input.dischargePort,
            reviewPorts: review.result_jsonb.ports,
          },
        );
      }
      if (!eligibility.bookable) {
        throw HttpError.unprocessable(
          'port_not_dischargeable',
          `卸港 ${input.dischargePort} 在该审查中不满足受理条件（实际卸箱 ${eligibility.dischargedCount}、受阻 ${eligibility.blockedCount}）：必须有实际卸箱且无受阻箱`,
          {
            dischargePort: input.dischargePort,
            dischargedBoxCount: eligibility.dischargedCount,
            blockedBoxCount: eligibility.blockedCount,
          },
        );
      }

      // 保存点：INSERT 撞约束后事务进入 aborted 状态，须回滚到保存点才能重查“先到”的预订
      await client.query('SAVEPOINT before_insert');

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO berth_bookings
             (review_id, voyage_id, manifest_rev, discharge_port, berth,
              start_at, end_at, submission_no, discharged_box_count, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING ${BOOKING_COLUMNS}`,
          [
            review.id,
            review.voyage_id,
            review.manifest_rev,
            input.dischargePort,
            input.berth,
            start.toISOString(),
            end.toISOString(),
            input.submissionNo,
            eligibility.dischargedCount,
            requestHash,
          ],
        );
      } catch (insertErr) {
        // 约束兜底。并发下另一事务可能先提交了：
        //  (a) 同一提交号（唯一约束）；(b) 同审查同港的有效预订（部分唯一索引）。
        if (insertErr && typeof insertErr === 'object' && 'constraint' in insertErr) {
          const constraint = (insertErr as { constraint?: string }).constraint;
          if (
            constraint === 'berth_bookings_review_id_submission_no_key' ||
            constraint === 'uq_berth_bookings_one_active_per_review_port'
          ) {
            // 退出 aborted 状态后重查“先到”的预订
            await client.query('ROLLBACK TO SAVEPOINT before_insert');
            const sameRes = await client.query(
              `SELECT ${BOOKING_COLUMNS} FROM berth_bookings
               WHERE review_id=$1 AND submission_no=$2`,
              [reviewId, input.submissionNo],
            );
            const sameSubmission = sameRes.rows[0] as BookingRow | undefined;
            if (sameSubmission) {
              // 同提交号：同内容幂等返回原预订当前状态，改内容冲突
              if (sameSubmission.request_hash === requestHash) {
                await client.query('RELEASE SAVEPOINT before_insert');
                await client.query('COMMIT');
                return { replay: true, booking: bookingToJson(sameSubmission) };
              }
              throw HttpError.conflict(
                'submission_no_conflict',
                `提交号 ${input.submissionNo} 在该审查内已用于不同内容，提交号唯一且不可复用；重新预订请改用新提交号`,
                { submissionNo: input.submissionNo },
              );
            }
            // 非提交号冲突：同审查同卸港已有有效预订（串行第二次预订或并发抢先）
            throw HttpError.conflict(
              'active_booking_exists',
              `该审查在卸港 ${input.dischargePort} 已有有效预订，同一审查同一卸港至多一个有效预订`,
              { dischargePort: input.dischargePort },
            );
          }
        }
        throw mapInsertError(
          insertErr as { code?: string; constraint?: string },
          input,
          start,
          end,
        );
      }

      await client.query('RELEASE SAVEPOINT before_insert');
      const row = inserted.rows[0] as BookingRow;
      await client.query('COMMIT');
      return { replay: false, booking: bookingToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 按预订 ID 取消：保留记录、释放窗口占用（active -> cancelled）。
   *  - 未知预订 -> 404 berth_booking_not_found；
   *  - 重复取消 -> 200 replay:true 返回已取消状态；
   *  - 取消后可在同审查同港重新预订，但须使用新提交号。
   */
  async cancelBooking(bookingId: string): Promise<{ replay: boolean; booking: ReturnType<typeof bookingToJson> }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 单行原子状态迁移：并发取消只有一方首次生效
      const res = await client.query(
        `UPDATE berth_bookings SET status='cancelled', cancelled_at=now()
         WHERE id=$1 AND status='active'
         RETURNING ${BOOKING_COLUMNS}`,
        [bookingId],
      );
      if (res.rows.length === 1) {
        const row = res.rows[0] as BookingRow;
        await client.query('COMMIT');
        return { replay: false, booking: bookingToJson(row) };
      }

      // 已取消（幂等返回当前状态）或本就不存在（404）
      const existing = await client.query(
        `SELECT ${BOOKING_COLUMNS} FROM berth_bookings WHERE id=$1`,
        [bookingId],
      );
      if (existing.rows.length === 0) {
        throw HttpError.notFound('berth_booking_not_found', `靠泊预订 ${bookingId} 不存在`);
      }
      const row = existing.rows[0] as BookingRow;
      await client.query('COMMIT');
      return { replay: true, booking: bookingToJson(row) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 取单条预订（含状态） */
  async getBooking(bookingId: string) {
    const res = await this.pool.query(
      `SELECT ${BOOKING_COLUMNS} FROM berth_bookings WHERE id=$1`,
      [bookingId],
    );
    if (res.rows.length === 0) {
      throw HttpError.notFound('berth_booking_not_found', `靠泊预订 ${bookingId} 不存在`);
    }
    return bookingToJson(res.rows[0] as BookingRow);
  }

  /**
   * 按审查列出全部预订与状态（含已取消记录，按创建先后）。
   * 未知审查 -> 404 discharge_review_not_found。
   */
  async listByReview(reviewId: string) {
    const review = await this.pool.query(`SELECT id FROM discharge_reviews WHERE id=$1`, [reviewId]);
    if (review.rows.length === 0) {
      throw HttpError.notFound('discharge_review_not_found', `卸货审查 ${reviewId} 不存在`);
    }
    const res = await this.pool.query(
      `SELECT ${BOOKING_COLUMNS} FROM berth_bookings
       WHERE review_id=$1 ORDER BY created_at, id`,
      [reviewId],
    );
    return {
      reviewId,
      bookings: (res.rows as BookingRow[]).map((r) => bookingToJson(r)),
    };
  }
}
