/**
 * 靠泊窗口预订的纯领域函数。
 *
 * 港口调度员依据【已留档的卸货审查】预订某卸港的靠泊窗口。
 * 是否受理完全取决于审查创建时冻结的逐港模拟结果：
 *
 *  - 卸港必须出现在审查提交的港序列表中（否则为“未知卸港”）；
 *  - 该港必须【有实际卸箱】：该港 portResult.discharged 非空
 *    （箱在其卸港当港真正卸离船舶；受阻箱最终未卸，不计入）；
 *  - 且该港【无受阻箱】：该港 portResult.blocked 为空。
 *
 * 同时满足才“可卸”（bookable）。这些事实取自冻结的 result_jsonb，
 * 航次后续调整或签发新清单不影响判定。
 */

import { DischargeSimulation } from './discharge';

export interface PortEligibility {
  port: string;
  /** 卸港是否在审查港序列表中 */
  known: boolean;
  /** 该港当港实际卸离船舶的箱数（discharged 条数） */
  dischargedCount: number;
  /** 该港受阻留船的箱数（blocked 条数） */
  blockedCount: number;
  /** 可受理预订：已知卸港、有实际卸箱、无受阻箱 */
  bookable: boolean;
}

/** 评估某卸港在给定（冻结）卸货模拟结果下是否可预订靠泊窗口 */
export function evaluatePort(simulation: DischargeSimulation, port: string): PortEligibility {
  const result = simulation.portResults.find((p) => p.port === port);
  if (!result) {
    return { port, known: false, dischargedCount: 0, blockedCount: 0, bookable: false };
  }
  const dischargedCount = result.discharged.length;
  const blockedCount = result.blocked.length;
  return {
    port,
    known: true,
    dischargedCount,
    blockedCount,
    bookable: dischargedCount > 0 && blockedCount === 0,
  };
}
