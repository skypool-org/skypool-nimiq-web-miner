importScripts('./worker.js');

let threadNo;

async function importScript(script, module = 'Module') {
    if (module && IWorker._global[module] && IWorker._global[module].asm) return false;
    if (typeof Nimiq !== 'undefined' && Nimiq._path) script = `${Nimiq._path}${script}`;
    if (typeof __dirname === 'string' && script.indexOf('/') === -1) script = `${__dirname}/${script}`;

    const moduleSettings = IWorker._global[module] || {};
    return new Promise(async (resolve, reject) => {
        if (module) {
            switch (typeof moduleSettings.preRun) {
                case 'undefined':
                    moduleSettings.preRun = () => resolve(true);
                    break;
                case 'function':
                    moduleSettings.preRun = [moduleSettings, () => resolve(true)];
                    break;
                case 'object':
                    moduleSettings.preRun.push(() => resolve(true));
            }
        }
        if (typeof importScripts === 'function') {
            await new Promise((resolve) => {
                IWorker._moduleLoadedCallbacks[module] = resolve;
                importScripts(script);
            });
            IWorker._global[module] = IWorker._global[module](moduleSettings);
            if (!module) resolve(true);
        } else if (typeof window === 'object') {
            await new Promise((resolve) => {
                IWorker._loadBrowserScript(script, resolve);
            });
            IWorker._global[module] = IWorker._global[module](moduleSettings);
            if (!module) resolve(true);
        } else if (typeof require === 'function') {
            IWorker._global[module] = require(script)(moduleSettings);
            if (!module) resolve(true);
        } else {
            reject('No way to load scripts.');
        }
    });
}

async function importWasm(wasm, module = 'Module') {
    if (typeof Nimiq !== 'undefined' && Nimiq._path) wasm = `${Nimiq._path}${wasm}`;
    if (typeof __dirname === 'string' && wasm.indexOf('/') === -1) wasm = `${__dirname}/${wasm}`;
    if (!IWorker._global.WebAssembly) {
        Log.w(IWorker, 'No support for WebAssembly available.');
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', wasm, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                IWorker._global[module] = IWorker._global[module] || {};
                IWorker._global[module].wasmBinary = xhr.response;
                resolve(true);
            };
            xhr.onerror = function () {
                Log.w(IWorker, `Failed to access WebAssembly module ${wasm}`);
                resolve(false);
            };
            xhr.send(null);
        } catch (e) {
            Log.w(IWorker, `Failed to access WebAssembly module ${wasm}`);
            resolve(false);
        }
    });
}

async function initWasm(name) {
    if (await importWasm('./worker-wasm.wasm')) {
        await importScript('./worker-wasm.js');
    } else {
        await importScript('./worker-js.js');
    }
}

async function multiMine(blockHeaderBuffer, compact, minNonce, maxNonce, timeNonce36) {
    const hash = new Uint8Array(32);
    let wasmOut, wasmIn;
    try {
        const input = new SerialBuffer(blockHeaderBuffer);
        input._writePos = input._view.byteLength;

        wasmOut = Module._malloc(hash.length);
        wasmIn = Module._malloc(input.length);
        Module.HEAPU8.set(input, wasmIn);
        const nonce = Module._nimiq_hard_hash_target(wasmOut, wasmIn, input.length, compact, minNonce, maxNonce, 512);
        if (nonce === maxNonce) {
            postMessage(['result', { startNonce: minNonce, endNonce: maxNonce, timeNonce36 }]);
            postMessage(['ready', {}]);
            return;
        }
        hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, hash.length));
        postMessage(['result', {hash, nonce, timeNonce36}]);
        postMessage(['ready', {}]);
    } catch (e) {
        Log.w('multiMine', e);
        throw e;
    } finally {
        if (wasmOut !== undefined) Module._free(wasmOut);
        if (wasmIn !== undefined) Module._free(wasmIn);
    }
}


async function initWorker() {
    await initWasm();
    Log.i(`MinerWorker ${threadNo}`, `MinerWorker thread ${threadNo} init complete`);
    postMessage(['ready', {}]);
}


onmessage = (e) => {
    const op = e.data[0];
    const data = e.data[1];
    switch (op) {
        case 'init': {
            threadNo = data.threadNo;
            initWorker();
            break;
        }
        case 'reready': {
            setTimeout(() => { postMessage(['ready', {}]); }, data.time);
            break;
        }
        case 'mine': {
            multiMine(data.blockHeaderBuffer, data.nBits, data.startNonce, data.endNonce, data.timeNonce36);
            break;
        }
        default:
            break;
    }
};
