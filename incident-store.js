import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createIncidentStore(file, { persistence } = {}) {
  let queue = Promise.resolve();
  async function read() {
    if (persistence) return persistence.read('incidents');
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid incident storage.');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  function mutate(operation) {
    if (persistence) return persistence.mutate('incidents', () => [], operation);
    const task = queue.then(async () => {
      const records = await read();
      const result = operation(records);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
      await rename(temp, file);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }
  return {
    transaction: persistence ? fn => persistence.transaction(fn) : null,
    withLease: persistence ? (key, fn) => persistence.withLease(key, fn) : async (key, fn) => fn(),
    async list() { await queue; return read(); },
    appendTriageReport(id, report) {
      return mutate(records => {
        const record = records.find(item => item.id === id);
        if (!record) throw Object.assign(new Error('Incident not found.'), { status: 404 });
        record.triageReports = [...(record.triageReports || []), report];
        record.revision = (record.revision || 0) + 1;
        record.updatedAt = new Date().toISOString();
        return record;
      });
    },
    appendTriageMessage(id, reportId, message) {
      return mutate(records => {
        const record = records.find(item => item.id === id);
        const report = record?.triageReports?.find(item => item.id === reportId);
        if (!report) throw Object.assign(new Error('Triage report not found.'), { status: 404 });
        report.chat = [...(report.chat || []), message];
        record.updatedAt = new Date().toISOString();
        return record;
      });
    },
    create(data) {
      return mutate(records => {
        const now = new Date().toISOString();
        const record = { ...data, id: `INC-${randomUUID().slice(0, 8).toUpperCase()}`, createdAt: now, updatedAt: now };
        records.push(record);
        return record;
      });
    },
    update(id, data, expectedRevision) {
      return mutate(records => {
        const record = records.find(item => item.id === id);
        if (!record) throw Object.assign(new Error('Incident not found.'), { status: 404 });
        if (expectedRevision !== undefined && (record.revision || 0) !== expectedRevision) throw Object.assign(new Error('This case changed. Reload it before continuing.'), { status: 409 });
        Object.assign(record, data, { revision: (record.revision || 0) + 1, updatedAt: new Date().toISOString() });
        return record;
      });
    }
  };
}
