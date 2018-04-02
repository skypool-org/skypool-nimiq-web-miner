import io from 'socket.io-client';

let Log;

const K = 1024; // workload unit
const WORKLOADS = 20;
const COMMITS = 10;
const REGISTER_RETRY_TIME = 10000;
const PULLING_MIN_GAP = 5000;

function delay(t) {
  return new Promise((resolve) => { 
    setTimeout(resolve, t);
  });
}

class Miner {

  constructor() {
    Log = window.Nimiq.Log;

    /** miner metadata */
    this._version = 2;
    this._platform = window.navigator.userAgent;

    this._server = null;
    this._address = null;
    this._name = null;
    this._threads = null;
    this._pullWorkloads = null; // 每次 pull 的 workloads 数量
    this._needWorkloads =null; // 低于这个数，触发 pull
    this._commitWorkloads = null; // 每次默认提交的工作量

    /** miner state data */
    this._mining = false;
    // disconnect, registerFail, serverUnable, serverFull, waitPulling, mining
    this._miningState = 'disconnect';
    this._pulling = false;
    this._pullingTime = 0;
    this._activeThreads = 0;
    this._webWorkers = [];

    // hashrate computing
    this._hashCount = 0;
    this._hashrate = 0;
    this._hashArray = null;
    this._hashTimeArray = null;
    this._hashrateInterval = null;

    /** current mining block */
    this._blockHeaderBuffer = null;
    this._nBits = 0;
    this._timeNonce36 = '0';

    /** @type {Array.<startNonce (unit K): number>}>} */
    this._workloads = [];
    this._socket = null;

    this._minedWorkloads = 0;
  }

  start(_server, _address, _name, _threads) {
    this._server = _server;
    this._address = _address;
    this._name = _name;
    this._threads = _threads;
    this._pullWorkloads = WORKLOADS * this._threads; // 每次 pull 的 workloads 数量
    this._needWorkloads = WORKLOADS * this._threads / 2; // 低于这个数，触发 pull
    this._commitWorkloads = COMMITS * this._threads; // 每次默认提交的工作量
    Log.i('Miner', `start with server: ${this._server}, address: ${this._address}, 
      name: ${this._name}, thread: ${this._threads}`);
    this._initSocket();

    // hash computing
    this._hashCount = 0;
    this._hashrate = 0;
    this._hashArray = new Array(10);
    this._hashTimeArray = new Array(10);
    const now = new Date();
    for (let i = 0; i < this._hashArray.length; i++) {
      this._hashArray[i] = 0;
      this._hashTimeArray[i] = now;
    }
    this._hashrateInterval = setInterval(() => this._updateHashrate(), 5000);
  }

  stop() {
    Log.i('Miner', 'stop mining');
    this._socket.close();
    this._webWorkers.map((v) => { v.terminate(); });
    this._webWorkers = [];
    this._activeThreads = 0;
    clearInterval(this._hashrateInterval);
  }

  _initSocket() {
    this._socket = io(this._server, {secure: true});
    this._socket.on('connect', () => {
      Log.i(Miner, `connect mining pool success ${this._server}`);
      this._register();
    });

    this._socket.on('disconnect', (reason) => {
      Log.i(Miner, `lose ming pool connection, ${reason}`);
      this._mining = false;
      this._miningState = 'disconnect';
    });

    // registerBack
    this._socket.on('b', (data) => {
      // ok
      if (data === 'c') {
        // 注册成功
        Log.i(Miner, 'register to server ok');
      }
      // registerFail
      else if (data === 'b') {
        Log.e(Miner, 'register to server fail');
        setTimeout(() => { this._register(); }, REGISTER_RETRY_TIME);
        this._miningState = 'registerFail';
      }
      // serverUnable
      else if (data === 'a') {
        Log.e(Miner, 'server unable');
        setTimeout(() => { this._register(); }, REGISTER_RETRY_TIME);
        this._miningState = 'serverUnable';
      }
      // server full
      else if (data === 'd') {
        Log.e(Miner, 'server full');
        setTimeout(() => { this._register(); }, REGISTER_RETRY_TIME);
        this._miningState = 'serverFull';
      }
      // version too old
      else if (data === 'e') {
        Log.e(Miner, 'client version old, please download latest mining client');
        setTimeout(() => { this._register(); }, REGISTER_RETRY_TIME);
      }
      else {
        Log.e(Miner, 'unknown register back state');
        setTimeout(() => { this._register(); }, REGISTER_RETRY_TIME);
        this._miningState = 'registerFail';
      }
    });

    // on assignJob
    this._socket.on('j', data => {
      // 发送目前的工作量
      if (this._minedWorkloads > 0) {
        this._pushPartial(this._minedWorkloads);
        this._minedWorkloads = 0;
      }
      this._blockHeaderBuffer = data.a;
      const nBits36 = data.b;
      this._nBits = parseInt(nBits36, 36);
      this._timeNonce36 = data.c;
      const currentNonce36 = data.d;
      const currentNonce = parseInt(currentNonce36, 36);
      const maxNonce = currentNonce + this._pullWorkloads;
      this._workloads = [];
      for (let i = currentNonce; i < maxNonce; i++) {
        this._workloads.push(i);
      }
      Log.i(Miner, `on assignJob, timeNonce36 ${this._timeNonce36}, currentNonce ${currentNonce}`);
      this._miningState = 'mining';
      // 第一次收到任务分配，启动线程开始挖矿
      if (this._mining === false) {
        this._mining = true;
        this._initMultiWorker()
      }
    });

    // on pullBack
    this._socket.on('a', (data) => {
      this._pulling = false;
      if (data.a !== this._timeNonce36) {
        Log.i(Miner, 'pullBack expired');
        return;
      }
      const currentNonce36 = data.b;
      const currentNonce = parseInt(currentNonce36, 36);
      const maxNonce = currentNonce + this._pullWorkloads;
      for (let i = currentNonce; i < maxNonce; i++) {
        this._workloads.push(i);
      }
      this._miningState = 'mining';
      Log.i(Miner, `on pullBack, timeNonce36 ${this._timeNonce36}, currentNonce ${currentNonce}`);
    });
  }

  _register() {
    // register
    this._socket.emit('r', {
      a: this._address,
      n: this._name,
      v: this._version,
      p: this._platform,
      w: this._pullWorkloads,
      c: this._commitWorkloads,
    });
  }

  _pull() {
    if (this._pulling && ( (new Date().getTime()) - this._pullingTime < PULLING_MIN_GAP ) ) {
      return;
    }
    Log.v(Miner, `emit pull, current workloads ${this._workloads.length}`);
    this._pulling = true;
    this._pullingTime = new Date().getTime();
    // pull
    this._socket.emit('p');
  }

  _push() {
    // push
    Log.i(Miner, `push ${this._commitWorkloads} K`);
    this._socket.emit('u');
  }

  _pushPartial(minedWorkloads) {
    // pushPartial
    Log.i(Miner, `push partial ${minedWorkloads} K`);
    this._socket.emit('t', minedWorkloads.toString(36));
  }

  _pushShare(data) {
    this._socket.emit('s', {
      a: data.timeNonce36,
      b: data.nonce,
      c: data.hash,
    });
    this._socket.emit('s', {
      a: data.timeNonce36,
      b: data.nonce,
      c: data.hash,
    });
  }

  _initMultiWorker() {
    for (let i = 0; i < this._threads; i++) {
      this._initWorker().catch((e) => Log.e(Miner, e));
    }
  }

  async _initWorker() {
    const threadNo = this._activeThreads;
    if (this._mining && this._activeThreads < this._threads) {
      this._activeThreads++;
    } else {
      if (!this._mining) {
        Log.e(Miner, `start Miner ${threadNo} fail, mining state is false`);
      } else {
        Log.e(Miner, `start Miner ${threadNo} fail, active threads are full`);
      }
      return;
    }

    const worker = new Worker("./lib/MinerWorker.min.js");
    this._webWorkers.push(worker);
    worker.onerror = (e) => {
        Log.e(Miner, `Miner ${threadNo}: ${e}`);
    };
    worker.onmessage = (e) => {
      const op = e.data[0];
      const data = e.data[1];
      switch (op) {
        case 'ready': {
          if (!this._mining) {
            this._activeThreads--;
            worker.terminate();
            Log.e(Miner, `Miner ${threadNo} exit, mining state is false`);
            return;
          }
          if (this._workloads.length <= this._needWorkloads) {
            this._pull();
          }
          const workload = this._workloads.shift();
          if (workload === undefined) {
            worker.postMessage(['reready', { time: 500 }]);
            Log.w(Miner, `Miner ${threadNo} waiting for pulling workloads`);
            this._miningState = 'waitPulling';
            break;
          }
          const blockHeaderBuffer = this._blockHeaderBuffer;
          const nBits = this._nBits;
          const timeNonce36 = this._timeNonce36;
          const startNonce = workload * K;
          const endNonce = startNonce + K;        
          worker.postMessage(['mine', {
            blockHeaderBuffer,
            nBits,
            startNonce,
            endNonce,
            timeNonce36,
          }]);
          break;
        }
        case 'result': {
          const result = data;
          if (result.hash) {
            Log.v(Miner, `Miner ${threadNo} mined a block and push share, timeNonce36 ${result.timeNonce36} nonce ${result.nonce}`);
            this._pushShare({
              timeNonce36: result.timeNonce36,
              nonce: result.nonce,
              hash: Array.from(result.hash),
            });
          } else {
            Log.v(Miner, `Miner ${threadNo} no-share, timeNonce36 ${result.timeNonce36} from ${result.startNonce} to ${result.endNonce}`);
          }
          this._hashCount += K;
          this._minedWorkloads++;
          if (this._minedWorkloads >= this._commitWorkloads) {
            this._minedWorkloads -= this._commitWorkloads;
            this._push();
          }
          break;
        }
        default:
          break;
      }
    };

    Log.i(Miner, `Miner ${threadNo} start`);
    delay(1000);
    worker.postMessage(['init', { threadNo }]);
  }

  _updateHashrate() {
    const preTime = this._hashTimeArray.shift();
    const nowTime = new Date();
    this._hashTimeArray.push(nowTime);
    this._hashArray.shift();
    this._hashArray.push(this._hashCount);
    this._hashCount = 0;
    
    const totalCount = this._hashArray.reduce((a, b) => a + b, 0);
    this._hashrate = Math.round(totalCount / (nowTime - preTime) * 1000);

    Log.i(Miner, `current hashrate: ${this._hashrate}`);
  }

  get hashrate() {
    return this._hashrate;
  }

  get miningState() {
    return this._miningState;
  }

}

export default Miner;
