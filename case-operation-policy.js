// Conservative MVP rules, not a complete engineering hazard classifier.
const operations = [
  ['safety', 'Safety protection changes', /\b(?:bypass|disable|override|defeat|silence)\b.{0,45}\b(?:interlock|protection|safety|alarm)\b|(?:绕过|屏蔽|短接|禁用|关闭).{0,12}(?:联锁|保护|报警)/i],
  ['equipment', 'Equipment state change', /\b(?:restart|reboot|reset|shut\s*down|power\s*cycle|switch\s+off|switch\s+on)\b|\bchange\b.{0,25}\b(?:operating|operation|run)\s+mode\b|重启|复位|停机|开机|切换.{0,8}(?:运行|模式)/i],
  ['settings', 'Operating parameter change', /\b(?:change|adjust|raise|lower|increase|decrease|modify|set)\b.{0,45}\b(?:setpoint|set point|pressure|temperature|threshold|control logic|speed)\b|(?:修改|调整|调高|调低|提高|降低|设置).{0,15}(?:温度|压力|阈值|设定|控制逻辑|转速)/i],
  ['isolation', 'Energy isolation or restoration', /\b(?:isolate|disconnect|reconnect|restore|cut|turn\s+off|turn\s+on)\b.{0,35}\b(?:power|electricity|supply|breaker)\b|\b(?:open|close|shut)\b.{0,25}\bvalve\b|断电|送电|恢复供电|(?:关闭|开启|打开).{0,8}阀门/i],
  ['maintenance', 'Intrusive maintenance', /\b(?:dismantle|disassemble|rewire)\b|\b(?:replace|remove|repair|open)\b.{0,35}\b(?:motor|compressor|panel|wiring|pump|electrical|pressurized|pressurised)\b|拆卸|拆开|更换.{0,8}(?:电机|压缩机|水泵|部件)|电气维修|带压作业/i],
  ['critical', 'Critical service intervention', /\b(?:stop|disable|switch|disconnect|shut|change)\b.{0,60}\b(?:fire system|fire pump|lift|elevator|data centre|data center|critical cooling)\b|(?:停用|停止|切换|关闭|修改).{0,15}(?:消防|电梯|数据中心|关键制冷)/i]
];
const asking = /\?|？|\b(?:should|shall|can|could|may|must|need to|want to|plan to|going to|how to|please|recommend|suggest)\b|是否|能否|可以|要不要|怎么|如何|打算|准备|需要|建议|请/i;
const explanation = /\b(?:what (?:is|does)|meaning of|explain|definition|what happened|why did)\b|是什么意思|解释|什么是|为什么.*(?:了|过)/i;
const history = /\b(?:already|yesterday|previously|last night|we did|i did|we have|i have|was|were|had)\b|\b(?:restarted|resetting was|replaced|adjusted|disconnected)\b|已经|昨天|此前|之前|刚才|没有进行|尚未进行/i;
const negative = /\b(?:do not|don't|never|no need to|not going to|without)\b|(?<!要)不要|无需|不打算|禁止/i;

export function detectCaseOperations(text = '') {
  const found = new Map();
  // Keep question punctuation and prevent a later negation from suppressing it.
  for (const clause of text.split(/(?<=[.!?。！？\n;；])|\bbut\b|但是/iu)) {
    const question = asking.test(clause);
    if (explanation.test(clause) || negative.test(clause) || (!question && history.test(clause))) continue;
    for (const [kind, label, pattern] of operations) {
      const match = pattern.exec(clause);
      if (match && (question || match.index < 12)) found.set(kind, { kind, label });
    }
  }
  return [...found.values()];
}
