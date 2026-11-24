// Separate OS process: each scheduler has its own busy flag and worker identity.
let release;
require('../../src/services/reportRenderer').renderReport = async () => {
  await new Promise(resolve => { release = resolve; process.send({ event: 'rendering' }); });
  return { json: { sheets: {} }, xlsx: Buffer.from('test-xlsx').toString('base64'), pdf: Buffer.from('test-pdf').toString('base64') };
};
const service = require('../../src/services/reportStudio');
const db = require('../../src/config/database');
process.on('message', async ({ id, command }) => {
  try {
    if (command === 'release') release?.();
    else if (command === 'tick') await service.tick();
    else if (command === 'start') await service.start();
    else if (command === 'stop') await service.stop();
    else if (command === 'close') {
      await service.stop();
      await new Promise(resolve => db.close(resolve));
      await new Promise(resolve => db.collaborationDb.close(resolve));
    }
    process.send({ id, ok: true });
    if (command === 'close') process.disconnect();
  } catch (error) { process.send({ id, error: error.stack }); }
});
