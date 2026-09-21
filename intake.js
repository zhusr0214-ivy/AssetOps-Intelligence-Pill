export const priorities = ['low', 'medium', 'high', 'urgent'];
export const categories = ['hvac', 'water_leak', 'energy', 'other', 'hvac_cooling', 'hvac_local_comfort', 'electrical_distribution', 'lift_fault'];
export const fields = ['title', 'description', 'location', 'asset', 'category', 'occurredAt', 'impact', 'observations', 'actionsTaken', 'affectedScope', 'priority'];

export function validateFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Expected a case object.'), { status: 400 });
  const result = {};
  for (const key of fields) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 6000) throw Object.assign(new Error(`Invalid ${key}. Use text up to 6000 characters.`), { status: 400 });
    result[key] = input[key].trim();
  }
  if (result.priority && !priorities.includes(result.priority)) throw Object.assign(new Error('Invalid priority.'), { status: 400 });
  if (result.category && !categories.includes(result.category)) throw Object.assign(new Error('Invalid category.'), { status: 400 });
  return result;
}

// Conservative local extraction: only copy explicit matches; user-entered fields win.
export function analyzeIntake(input) {
  const supplied = validateFields(input);
  const data = Object.fromEntries(fields.map(key => [key, supplied[key] || '']));
  const source = data.description;
  const extractedFields = {};
  function suggest(key, value) {
    if (!data[key] && value) data[key] = extractedFields[key] = value;
  }
  suggest('title', source.split(/[\n.!?。！？]/u)[0]?.slice(0, 100));
  suggest('asset', source.match(/\b(?:AHU|FCU|CH|PUMP)[- ][A-Z0-9]+(?:-[A-Z0-9]+)*\b/i)?.[0]);
  suggest('location', source.match(/(?:[A-Z]\s*栋\s*)?(?:\d+\s*(?:层|楼)(?:\s*[东西南北]区)?|(?:level|floor)\s*\d+(?:\s*(?:east|west|north|south))?)/i)?.[0]);
  suggest('occurredAt', source.match(/(?:今天|昨天|今日|昨日)?(?:上午|下午|晚上)?\s*\d{1,2}(?::\d{2}|点(?:半)?)(?:左右)?|\b(?:today|yesterday)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i)?.[0]);
  suggest('observations', source.match(/\d+(?:\.\d+)?\s*(?:°\s*C|℃|kWh|kW|摄氏度)/i)?.[0]);
  if (!data.category && source) {
    const matches = [
      ['water_leak', /漏水|渗水|water\s*leak|leaking/i],
      ['energy', /能耗|用电|energy|power consumption/i],
      ['hvac', /空调|闷热|制冷|hvac|overheat|air.condition|\bAHU\b|\bFCU\b/i]
    ].filter(([, pattern]) => pattern.test(source));
    suggest('category', matches.length === 1 ? matches[0][0] : 'other');
  }
  return assessIntake(data, extractedFields, 'local-rules');
}

// 问题在这里集中定义；不改变现有保存字段或人工提交条件。
const domainQuestions = [
  { id: 'lift_entrapment', categories: ['lift_fault'], field: 'observations', safety: true, binary: true,
    question: 'Is anyone trapped inside the lift?', zh: '是否有人被困在电梯里？',
    covered: /no (?:one|passengers?|people) (?:is |are )?trapped|(?:someone|a person|passengers?|people) (?:is|are) trapped|无人被困|没有人被困|有人被困/i },
  { id: 'lift_fault_code', categories: ['lift_fault'], field: 'observations',
    question: 'What fault message or code is displayed, if any?', zh: '电梯显示了什么故障信息或代码？没有或不知道也可以说明。',
    covered: /door control fault|(?:shows?|displays?) (?:a |an )?(?:[\w-]+ ){0,3}fault|fault code\s*[:=]|no fault (?:message|code)|门控故障|故障代码[：:]|没有故障代码/i },
  { id: 'lift_others', categories: ['lift_fault'], field: 'observations', binary: true,
    question: 'Are the other lifts operating normally?', zh: '其他电梯是否正常运行？',
    covered: /other lifts (?:are |appear to be )?(?:operating|working|normal|stopped|unavailable)|其他电梯.*(?:正常|停运|故障)/i },
  { id: 'leak_electrical', categories: ['water_leak'], field: 'observations', safety: true, binary: true,
    question: 'Is any electrical equipment near or in contact with the leaking water?', zh: '漏水附近是否有电气设备，或水是否接触了电气设备？',
    covered: /lighting fixture.*nearby|(?:no |any )?electrical equipment (?:is )?(?:nearby|near|affected)|water.*(?:touching|contact with).*electrical|附近.*(?:灯具|电气设备|电器)|(?:灯具|电气设备|电器).*附近/i },
  { id: 'leak_access', categories: ['water_leak'], field: 'actionsTaken', safety: true, binary: true,
    question: 'Has access to the affected area been restricted?', zh: '是否已限制人员进入受影响区域？',
    covered: /restricted access|access (?:has |has not |is |is not )?(?:been )?restricted|area (?:has |has not |is |is not )?(?:been )?isolated|限制通行|限制.*进入|(?:已|未|没有).*隔离/i },
  { id: 'leak_active', categories: ['water_leak'], field: 'observations', binary: true,
    question: 'Is the leak still active?', zh: '现在是否仍在漏水？',
    covered: /leaking continuously|leak is (?:still active|ongoing|stopped)|leak has stopped|持续漏水|仍在漏水|已经停止漏水/i },
  { id: 'electrical_warning', categories: ['electrical_distribution'], field: 'observations', safety: true, binary: true,
    question: 'Has anyone observed smoke, a burning smell or abnormal heat?', zh: '是否观察到烟雾、焦味或异常发热？',
    covered: /no smoke or burning smell|(?:observed|noticed|reported) (?:smoke|a burning smell|abnormal heat)|(?:smoke|burning smell|abnormal heat) (?:has been|was|is) (?:observed|noticed|reported|present)|(?:没有|未见|出现|发现|有).*?(?:烟雾|焦味|异常发热)/i },
  { id: 'electrical_critical', categories: ['electrical_distribution'], field: 'observations', safety: true, binary: true,
    question: 'Are any critical systems or essential services affected?', zh: '是否影响关键系统或重要服务？',
    covered: /(?:no |any )?critical (?:systems|loads).*?(?:affected|normal|unaffected)|essential services.*?(?:affected|normal|unaffected)|关键系统.*(?:受影响|正常)|(?:未影响|不影响|影响了).*关键/i },
  { id: 'electrical_trip', categories: ['electrical_distribution'], field: 'observations', binary: true,
    question: 'Has any breaker tripped?', zh: '是否有断路器跳闸？',
    covered: /breaker.*(?:tripped|trip)|断路器.*跳闸/i },
  { id: 'hvac_scope', categories: ['hvac', 'hvac_cooling', 'hvac_local_comfort'], field: 'affectedScope',
    question: 'Is the issue limited to one room or zone, or are multiple areas affected?', zh: '问题仅限一个房间或区域，还是多个区域都受影响？',
    covered: /(?:limited|confined) to|multiple (?:areas|zones).*affected|affects the east|nearby offices (?:appear |are )?normal|仅限|多个区域.*受影响|附近办公室.*正常|东区.*西区/i },
  { id: 'hvac_local_airflow', categories: ['hvac_local_comfort'], field: 'observations',
    question: 'What is the local VAV response and measured airflow, if known?', zh: '局部 VAV 响应和实测风量如何？不知道也可以说明。',
    covered: /VAV.*(?:command|response|position)|measured airflow|VAV.*(?:开度|指令|响应)|实测风量/i },
  { id: 'hvac_filter_dp', categories: ['hvac_cooling'], field: 'observations',
    question: 'What is the filter differential pressure reading and its normal reference range, if known?', zh: '过滤器压差读数和正常参考范围是多少？不知道也可以说明。',
    covered: /(?:filter|differential pressure|压差).*\d+(?:\.\d+)?\s*(?:Pa|kPa|帕)/i }
];

function questionAnswer(messages, question) {
  let lastAnswer = '';
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i];
    if (message.role !== 'assistant' || !(message.content.includes(question.question) || message.content.includes(question.zh))) continue;
    const next = messages[i + 1];
    if (next.role !== 'user') continue;
    const answer = next.content.trim();
    if (/^(?:unknown|not sure|(?:i )?don['’]?t know|不知道|不清楚|未知)[.!。]?$/i.test(answer)) lastAnswer = 'unknown';
    else if (question.binary && /^(?:yes|no|是|不是|有|没有|没有了)[.!。]?$/i.test(answer)) lastAnswer = answer;
    else if (question.covered.test(answer)) lastAnswer = 'answered';
    else if (question.id === 'hvac_filter_dp' && /^\d+(?:\.\d+)?\s*(?:Pa|kPa|帕)[.!。]?$/i.test(answer)) lastAnswer = 'answered';
    else if (question.id === 'lift_fault_code' && /^(?:none|no code|没有|无|[A-Z]+[- ]?\d+)[.!。]?$/i.test(answer)) lastAnswer = 'answered';
  }
  return lastAnswer;
}

function assessDomain(data, messages = []) {
  // Only user reports and saved facts count as evidence, not assistant questions.
  const facts = [data.description, data.observations, data.actionsTaken, data.affectedScope,
    ...messages.filter(m => m.role === 'user').map(m => m.content)].filter(Boolean).join('\n');
  const pending = [];
  const unresolvedSafety = [];
  for (const question of domainQuestions.filter(q => q.categories.includes(data.category))) {
    if (question.id === 'hvac_scope' && data.affectedScope) continue;
    if (question.covered.test(facts)) continue;
    const answer = questionAnswer(messages, question);
    if (answer === 'unknown' && question.safety) unresolvedSafety.push(question.id);
    if (answer) continue;
    pending.push({ ...question, domain: true });
  }
  return { pending, unresolvedSafety };
}

export function assessIntake(input, extractedFields = {}, mode = 'manual') {
  const supplied = validateFields(input);
  const data = Object.fromEntries(fields.map(key => [key, supplied[key] || '']));
  const questions = {
    description: 'What happened? Describe the issue you observed.',
    location: 'Where is the issue occurring? Please include the building, floor, and room or area if known.',
    priority: 'Which priority do you want to assign: Low, Medium, High or Urgent?',
    occurredAt: 'When did the issue start? Enter Unknown if you do not know.',
    impact: 'How is this issue affecting occupants or services, such as discomfort, delays or loss of power? Enter Unknown if you do not know.'
  };
  const missingFields = Object.keys(questions).filter(key => !data[key]);
  const domain = assessDomain(data, Array.isArray(input.messages) ? input.messages : []);
  return {
    mode, fields: data, extractedFields, missingFields,
    followUpQuestions: [...domain.pending, ...missingFields.map(field => ({ field, question: questions[field] }))],
    unresolvedSafety: domain.unresolvedSafety,
    readyForTriage: missingFields.length === 0,
    completionStatus: missingFields.length ? 'missing_information' : 'ready_for_confirmation'
  };
}
