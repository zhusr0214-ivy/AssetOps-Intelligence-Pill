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

// Define follow-up questions without changing manual submission requirements.
const domainQuestions = [
  { id: 'lift_entrapment', categories: ['lift_fault'], field: 'observations', safety: true, binary: true,
    question: 'Is anyone trapped inside the lift?',
    covered: /no (?:one|passengers?|people) (?:is |are )?trapped|(?:someone|a person|passengers?|people) (?:is|are) trapped|\u65e0\u4eba\u88ab\u56f0|\u6ca1\u6709\u4eba\u88ab\u56f0|\u6709\u4eba\u88ab\u56f0/i },
  { id: 'lift_fault_code', categories: ['lift_fault'], field: 'observations',
    question: 'What fault message or code is displayed, if any?',
    covered: /door control fault|(?:shows?|displays?) (?:a |an )?(?:[\w-]+ ){0,3}fault|fault code\s*[:=]|no fault (?:message|code)|\u95e8\u63a7\u6545\u969c|\u6545\u969c\u4ee3\u7801[：:]|\u6ca1\u6709\u6545\u969c\u4ee3\u7801/i },
  { id: 'lift_others', categories: ['lift_fault'], field: 'observations', binary: true,
    question: 'Are the other lifts operating normally?',
    covered: /other lifts (?:are |appear to be )?(?:operating|working|normal|stopped|unavailable)|\u5176\u4ed6\u7535\u68af.*(?:\u6b63\u5e38|\u505c\u8fd0|\u6545\u969c)/i },
  { id: 'leak_electrical', categories: ['water_leak'], field: 'observations', safety: true, binary: true,
    question: 'Is any electrical equipment near or in contact with the leaking water?',
    covered: /lighting fixture.*nearby|(?:no |any )?electrical equipment (?:is )?(?:nearby|near|affected)|water.*(?:touching|contact with).*electrical|\u9644\u8fd1.*(?:\u706f\u5177|\u7535\u6c14\u8bbe\u5907|\u7535\u5668)|(?:\u706f\u5177|\u7535\u6c14\u8bbe\u5907|\u7535\u5668).*\u9644\u8fd1/i },
  { id: 'leak_access', categories: ['water_leak'], field: 'actionsTaken', safety: true, binary: true,
    question: 'Has access to the affected area been restricted?',
    covered: /restricted access|access (?:has |has not |is |is not )?(?:been )?restricted|area (?:has |has not |is |is not )?(?:been )?isolated|\u9650\u5236\u901a\u884c|\u9650\u5236.*\u8fdb\u5165|(?:\u5df2|\u672a|\u6ca1\u6709).*\u9694\u79bb/i },
  { id: 'leak_active', categories: ['water_leak'], field: 'observations', binary: true,
    question: 'Is the leak still active?',
    covered: /leaking continuously|leak is (?:still active|ongoing|stopped)|leak has stopped|\u6301\u7eed\u6f0f\u6c34|\u4ecd\u5728\u6f0f\u6c34|\u5df2\u7ecf\u505c\u6b62\u6f0f\u6c34/i },
  { id: 'electrical_warning', categories: ['electrical_distribution'], field: 'observations', safety: true, binary: true,
    question: 'Has anyone observed smoke, a burning smell or abnormal heat?',
    covered: /no smoke or burning smell|(?:observed|noticed|reported) (?:smoke|a burning smell|abnormal heat)|(?:smoke|burning smell|abnormal heat) (?:has been|was|is) (?:observed|noticed|reported|present)|(?:\u6ca1\u6709|\u672a\u89c1|\u51fa\u73b0|\u53d1\u73b0|\u6709).*?(?:\u70df\u96fe|\u7126\u5473|\u5f02\u5e38\u53d1\u70ed)/i },
  { id: 'electrical_critical', categories: ['electrical_distribution'], field: 'observations', safety: true, binary: true,
    question: 'Are any critical systems or essential services affected?',
    covered: /(?:no |any )?critical (?:systems|loads).*?(?:affected|normal|unaffected)|essential services.*?(?:affected|normal|unaffected)|\u5173\u952e\u7cfb\u7edf.*(?:\u53d7\u5f71\u54cd|\u6b63\u5e38)|(?:\u672a\u5f71\u54cd|\u4e0d\u5f71\u54cd|\u5f71\u54cd\u4e86).*\u5173\u952e/i },
  { id: 'electrical_trip', categories: ['electrical_distribution'], field: 'observations', binary: true,
    question: 'Has any breaker tripped?',
    covered: /breaker.*(?:tripped|trip)|\u65ad\u8def\u5668.*\u8df3\u95f8/i },
  { id: 'hvac_scope', categories: ['hvac', 'hvac_cooling', 'hvac_local_comfort'], field: 'affectedScope',
    question: 'Is the issue limited to one room or zone, or are multiple areas affected?',
    covered: /(?:limited|confined) to|multiple (?:areas|zones).*affected|affects the east|nearby offices (?:appear |are )?normal|\u4ec5\u9650|\u591a\u4e2a\u533a\u57df.*\u53d7\u5f71\u54cd|\u9644\u8fd1\u529e\u516c\u5ba4.*\u6b63\u5e38|\u4e1c\u533a.*\u897f\u533a/i },
  { id: 'hvac_local_airflow', categories: ['hvac_local_comfort'], field: 'observations',
    question: 'What is the local VAV response and measured airflow, if known?',
    covered: /VAV.*(?:command|response|position)|measured airflow|VAV.*(?:\u5f00\u5ea6|\u6307\u4ee4|\u54cd\u5e94)|\u5b9e\u6d4b\u98ce\u91cf/i },
  { id: 'hvac_filter_dp', categories: ['hvac_cooling'], field: 'observations',
    question: 'What is the filter differential pressure reading and its normal reference range, if known?',
    covered: /(?:filter|differential pressure|\u538b\u5dee).*\d+(?:\.\d+)?\s*(?:Pa|kPa|\u5e15)/i }
];

function questionAnswer(messages, question) {
  let lastAnswer = '';
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.content.includes(question.question)) continue;
    const next = messages[i + 1];
    if (next.role !== 'user') continue;
    const answer = next.content.trim();
    if (/^(?:unknown|not sure|(?:i )?don['’]?t know|\u4e0d\u77e5\u9053|\u4e0d\u6e05\u695a|\u672a\u77e5)[.!。]?$/i.test(answer)) lastAnswer = 'unknown';
    else if (question.binary && /^(?:yes|no|\u662f|\u4e0d\u662f|\u6709|\u6ca1\u6709|\u6ca1\u6709\u4e86)[.!。]?$/i.test(answer)) lastAnswer = answer;
    else if (question.covered.test(answer)) lastAnswer = 'answered';
    else if (question.id === 'hvac_filter_dp' && /^\d+(?:\.\d+)?\s*(?:Pa|kPa|\u5e15)[.!。]?$/i.test(answer)) lastAnswer = 'answered';
    else if (question.id === 'lift_fault_code' && /^(?:none|no code|\u6ca1\u6709|\u65e0|[A-Z]+[- ]?\d+)[.!。]?$/i.test(answer)) lastAnswer = 'answered';
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
