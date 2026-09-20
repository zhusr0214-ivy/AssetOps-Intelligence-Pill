import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createIncidentStore(file) {
  let queue = Promise.resolve();
  async function read() {
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
    async list() { await queue; return read(); },
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
