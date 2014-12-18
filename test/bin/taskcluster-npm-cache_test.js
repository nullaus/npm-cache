import taskcluster from 'taskcluster-client';
import assert from 'assert';
import { spawn } from 'mz/child_process';
import eventToPromise from 'event-to-promise';
import http from 'http';
import slugid from 'slugid';
import request from 'superagent-promise';
import hash from '../../src/hash';
import fs from 'mz/fs';
import { Server as StaticServer } from 'node-static';

suite('taskcluster-npm-cache', function() {
  let BIN = `${__dirname}/../../build/bin/taskcluster-npm-cache.js`

  let queue = new taskcluster.Queue();
  let index = new taskcluster.Index();

  async function run(argv) {
    let proc = spawn(BIN, argv, { stdio: 'inherit' });
    return await eventToPromise(proc, 'exit');
  }

  async function createTask(npmCache={}) {
    let taskId = slugid.v4();
    let date = new Date();
    let deadline = new Date();
    deadline.setHours(deadline.getHours() + 2);

    let task = {
      provisionerId: 'null',
      workerType: 'null',
      created: date,
      deadline: deadline,
      payload: {},
      metadata: {
        name: 'test',
        description: 'xfoo',
        owner: 'jlal@mozilla.com',
        source: 'http://todo.com'
      },
      extra: {
        npmCache: npmCache
      }
    };

    await queue.createTask(taskId, task);
    return taskId;
  }

  async function claimAndCompleteTask(taskId) {
    await queue.claimTask(taskId, 0, {
      workerGroup: 'null',
      workerId: 'null'
    });
    await queue.reportCompleted(taskId, 0, { success: true });
  }

  let server, url;
  setup(function() {
    let file = new StaticServer(__dirname + '/../fixtures/');
    server = http.createServer((req, res) => {
      req.on('end', file.serve.bind(file, req, res)).resume();
    }).listen(0);

    let addr = server.address();

    url = `http://localhost:${addr.port}`
  });

  teardown(function() {
    server.close();
  });

  suite('simple new cache', function() {
    let taskId;
    let expectedExpires = new Date();
    expectedExpires.setMinutes(expectedExpires.getMinutes() + 5);

    setup(async function() {
      taskId = await createTask({
        url: `${url}/simple.json`,
        expires: expectedExpires
      });
      claimAndCompleteTask(taskId);
    });

    test('cache and then recache', async function() {
      // Calculate the hash so we know what to do later...
      let expectedHash = hash(
        await fs.readFile(`${__dirname}/../fixtures/simple.json`, 'utf8')
      );

      // Unique namespaces are used to ensure we are using new data each test.
      let namespace = slugid.v4();
      await run(['--task-id', taskId, '--namespace', namespace]);

      let url = queue.buildUrl(
        queue.getLatestArtifact, taskId, 'public/node_modules.tar.gz'
      );

      let res = await request.get(url).end();
      assert(res.ok, 'node_modules.tar.gz created');
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.headers['content-type'], 'application/x-tar');

      let indexedTask = await index.findTask(`${namespace}.${expectedHash}`);
      assert.equal(indexedTask.taskId, taskId);
      assert.equal(indexedTask.expires, expectedExpires.toJSON());

      // Rerun the task to check if we clobbered the original.
      await run(['--task-id', taskId, '--namespace', namespace]);
      let resAgain = await request.get(url).end();
      assert.equal(res.headers['etag'], resAgain.headers['etag']);
    });
  });
});
