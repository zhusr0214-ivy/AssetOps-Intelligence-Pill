export const priorities = ['low', 'medium', 'high', 'urgent'];
export const categories = [
  'hvac',
  'water_leak',
  'energy',
  'other',
  'hvac_cooling',
  'hvac_local_comfort',
  'electrical_distribution',
  'lift_fault'
];
export const fields = ['title', 'description', 'location', 'asset', 'category', 'occurredAt', 'impact', 'observations', 'actionsTaken', 'priority'];

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
  return {
    mode, fields: data, extractedFields, missingFields,
    followUpQuestions: missingFields.slice(0, 3).map(field => ({ field, question: questions[field] })),
    readyForTriage: missingFields.length === 0,
    completionStatus: missingFields.length ? 'missing_information' : 'ready_for_confirmation'
  };
}
