// Run by the installed root adapter through `docker exec -i api node -`.
// No API route, new permission or credentials in command-line arguments.
const { Queue } = require('bullmq');
const Redis = require('ioredis');

async function main() {
  const action = process.argv[2];
  if (!['status', 'pause', 'resume'].includes(action)) throw new Error('Invalid action');
  const connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  connection.on('error', () => {});
  const queue = new Queue('palcert-processing', { connection });
  try {
    if (action === 'pause') await queue.pause();
    if (action === 'resume') await queue.resume();
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed');
    console.log(JSON.stringify({ paused: await queue.isPaused(), active: counts.active ?? 0 }));
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

main().catch(() => {
  console.error('Queue control failed; values withheld');
  process.exitCode = 1;
});
