if (typeof JDB === 'undefined') {
    var JDB = {};
}
var Proxy; // ensure Proxy exists
(function (exports) {
    exports = typeof exports !== 'undefined' ? exports : {};

class Class {
    static register(cls) {
        if (typeof exports !== 'undefined') exports[cls.name] = cls;
    }
}
Class.register(Class);

class IDBTools {
    /**
     * Converts our KeyRange objects into IDBKeyRange objects.
     * @param {KeyRange} keyRange A KeyRange object.
     * @returns {IDBKeyRange} The corresponding IDBKeyRange.
     */
    static convertKeyRange(keyRange) {
        if (!(keyRange instanceof KeyRange)) return keyRange;
        if (keyRange.exactMatch) {
            return IDBKeyRange.only(keyRange.lower);
        }
        if (keyRange.lower !== undefined && keyRange.upper === undefined) {
            return IDBKeyRange.lowerBound(keyRange.lower, keyRange.lowerOpen);
        }
        if (keyRange.upper !== undefined && keyRange.lower === undefined) {
            return IDBKeyRange.upperBound(keyRange.upper, keyRange.upperOpen);
        }
        return IDBKeyRange.bound(keyRange.lower, keyRange.upper, keyRange.lowerOpen, keyRange.upperOpen);
    }
}
Class.register(IDBTools);

class LogNative {
    constructor() {
        this._global_level = Log.TRACE;
        this._tag_levels = {};
        try {
            if (window.localStorage) {
                try {
                    let c = window.localStorage.getItem('log_tag_levels');
                    if (c && typeof c === 'string') c = JSON.parse(c);
                    if (c && typeof c === 'object') this._tag_levels = c;
                } catch (e) {
                    console.warn('Failed to load log configuration from local storage.');
                }
            }
        } catch (e) {
            // ignore
        }
    }

    isLoggable(tag, level) {
        if (tag && this._tag_levels[tag]) {
            return this._tag_levels[tag] <= level;
        }
        if (this._tag_levels['*']) {
            return this._tag_levels['*'] <= level;
        }
        return this._global_level <= level;
    }

    setLoggable(tag, level) {
        if (tag && tag.name) tag = tag.name;
        this._tag_levels[tag] = level;
        if (window.localStorage) {
            window.localStorage.setItem('log_tag_levels', JSON.stringify(this._tag_levels));
        }
    }

    msg(level, tag, args) {
        if (tag && tag.name) tag = tag.name;
        if (!this.isLoggable(tag, level)) return;
        if (tag) args.unshift(tag + ':');
        args.unshift(`[${Log.Level.toStringTag(level)} ${new Date().toTimeString().substr(0, 8)}]`);
        if (console.error && level >= Log.ERROR) {
            console.error.apply(console, args);
        } else if (console.warn && level >= Log.WARNING) {
            console.warn.apply(console, args);
        } else if (console.info && level >= Log.INFO) {
            console.info.apply(console, args);
        } else if (console.debug && level >= Log.DEBUG) {
            console.debug.apply(console, args);
        } else if (console.trace && level <= Log.TRACE) {
            console.trace.apply(console, args);
        } else {
            console.log.apply(console, args);
        }
    }
}
Class.register(LogNative);

/**
 * A simple object implementing parts of the Transaction's class.
 * It is used to keep track of modifications on a persistent index
 * and to apply them all at once.
 * This class is to be used only internally.
 */
class EncodedTransaction {
    /**
     * Create a new IndexTransaction.
     */
    constructor(tableName) {
        this._tableName = tableName;
        this._modified = new Map();
        this._removed = new Set();
        this._truncated = false;
    }

    /** @type {string} */
    get tableName() {
        return this._tableName;
    }

    /** @type {Map.<string,*>} */
    get modified() {
        return this._modified;
    }

    /** @type {Set.<string>} */
    get removed() {
        return this._removed;
    }

    /** @type {boolean} */
    get truncated() {
        return this._truncated;
    }

    /**
     * Empty the index transaction.
     */
    truncate() {
        this._truncated = true;
        this._modified.clear();
        this._removed.clear();
    }

    /**
     * Put a key-value pair into the transaction.
     * @param {string} key The key.
     * @param {*} value The value.
     */
    put(key, value) {
        this._removed.delete(key);
        this._modified.set(key, value);

    }

    /**
     * Remove a key-value pair from the transaction.
     * @param {string} key The key to remove.
     */
    remove(key) {
        this._removed.add(key);
        this._modified.delete(key);
    }

}
Class.register(EncodedTransaction);

/**
 * This class is a wrapper around the IndexedDB.
 * It manages the access to a single table/object store.
 * @implements {IBackend}
 */
class IDBBackend {
    /**
     * Creates a wrapper given a JungleDB object and table name.
     * @param {JungleDB} db The JungleDB object managing the connection.
     * @param {string} tableName THe table name this object store represents.
     * @param {ICodec} [codec] Optional codec applied before storing/retrieving values in/from the backend (null is the identity codec).
     */
    constructor(db, tableName, codec=null) {
        this._db = db;
        this._tableName = tableName;
        /** @type {Map.<string,IIndex>} */
        this._indices = new Map();
        this._indicesToDelete = [];
        this._codec = codec;
    }

    /** @type {boolean} */
    get connected() {
        return this._db.connected;
    }

    /** @type {IDBDatabase} */
    get _backend() {
        if (!this.connected) {
            throw new Error('Requires a connected database');
        }
        return this._db.backend;
    }

    /**
     * A map of index names to indices.
     * The index names can be used to access an index.
     * @type {Map.<string,IIndex>}
     */
    get indices() {
        return this._indices;
    }

    /**
     * Internal method called by the JungleDB to create the necessary indices during a version upgrade.
     * @param {IDBObjectStore} objectStore The IDBObjectStore object obtained during a version upgrade.
     * @protected
     */
    init(objectStore) {
        // Delete indices.
        for (const indexName of this._indicesToDelete) {
            objectStore.deleteIndex(indexName);
        }
        delete this._indicesToDelete;

        // Create indices.
        for (const [indexName, index] of this._indices) {
            const keyPath = Array.isArray(index.keyPath) ? index.keyPath.join('.') : index.keyPath;
            objectStore.createIndex(indexName, keyPath, { unique: false, multiEntry: index.multiEntry});
        }
    }

    /**
     * Internal method called to decode a single value.
     * @param {*} value Value to be decoded.
     * @param {string} key Key corresponding to the value.
     * @returns {*} The decoded value.
     */
    decode(value, key) {
        if (value === undefined) {
            return undefined;
        }
        if (this._codec !== null && this._codec !== undefined) {
            return this._codec.decode(value, key);
        }
        return value;
    }

    /**
     * Internal method called to encode a single value.
     * @param {*} value Value to be encoded.
     * @returns {*} The encoded value.
     */
    encode(value) {
        if (value === undefined) {
            return undefined;
        }
        if (this._codec !== null && this._codec !== undefined) {
            return this._codec.encode(value);
        }
        return value;
    }

    /**
     * Returns a promise of the object stored under the given primary key.
     * Resolves to undefined if the key is not present in the object store.
     * @param {string} key The primary key to look for.
     * @returns {Promise.<*>} A promise of the object stored under the given key, or undefined if not present.
     */
    async get(key) {
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const getTx = db.transaction([this._tableName])
                .objectStore(this._tableName)
                .get(key);
            getTx.onsuccess = event => resolve(this.decode(event.target.result, key));
            getTx.onerror = reject;
        });
    }

    /**
     * Inserts or replaces a key-value pair.
     * @param {string} key The primary key to associate the value with.
     * @param {*} value The value to write.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    async put(key, value) {
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const putTx = db.transaction([this._tableName], 'readwrite')
                .objectStore(this._tableName)
                .put(this.encode(value), key);
            putTx.onsuccess = event => resolve(event.target.result);
            putTx.onerror = reject;
        });
    }

    /**
     * Removes the key-value pair of the given key from the object store.
     * @param {string} key The primary key to delete along with the associated object.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    async remove(key) {
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const deleteTx = db.transaction([this._tableName], 'readwrite')
                .objectStore(this._tableName)
                .delete(key);
            deleteTx.onsuccess = event => resolve(event.target.result);
            deleteTx.onerror = reject;
        });
    }

    /**
     * Returns a promise of an array of objects whose primary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the object store.
     * If the query is of type KeyRange, it returns all objects whose primary keys are within this range.
     * If the query is of type Query, it returns all objects whose primary keys fulfill the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    async values(query=null) {
        if (query !== null && query instanceof Query) {
            return query.values(this);
        }
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const results = [];
            const openCursorRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .openCursor(query);
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    results.push(this.decode(cursor.value, cursor.primaryKey));
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of a set of keys fulfilling the given query.
     * If the optional query is not given, it returns all keys in the object store.
     * If the query is of type KeyRange, it returns all keys of the object store being within this range.
     * If the query is of type Query, it returns all keys fulfilling the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to the query.
     */
    async keys(query=null) {
        if (query !== null && query instanceof Query) {
            return query.keys(this);
        }
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const results = new Set();
            const store = db.transaction([this._tableName], 'readonly').objectStore(this._tableName);
            const openCursorRequest = store.openKeyCursor ? store.openKeyCursor(query) : store.openCursor(query);
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    results.add(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    keyStream(callback, ascending=true, query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const store = db.transaction([this._tableName], 'readonly').objectStore(this._tableName);
            const openCursorRequest = store.openKeyCursor
                ? store.openKeyCursor(query, ascending ? 'next' : 'prev')
                : store.openCursor(query, ascending ? 'next' : 'prev');
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    if (callback(cursor.primaryKey)) {
                        cursor.continue();
                    } else {
                        resolve();
                    }
                } else {
                    resolve();
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    valueStream(callback, ascending=true, query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const openCursorRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .openCursor(query, ascending ? 'next' : 'prev');
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    if (callback(cursor.value, cursor.primaryKey)) {
                        cursor.continue();
                    } else {
                        resolve();
                    }
                } else {
                    resolve();
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of the object whose primary key is maximal for the given range.
     * If the optional query is not given, it returns the object whose key is maximal.
     * If the query is of type KeyRange, it returns the object whose primary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    async maxValue(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const openCursorRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .openCursor(query, 'prev');
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                resolve(cursor ? this.decode(cursor.value, cursor.primaryKey) : undefined);
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of the key being maximal for the given range.
     * If the optional query is not given, it returns the maximal key.
     * If the query is of type KeyRange, it returns the key being maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    async maxKey(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const store = db.transaction([this._tableName], 'readonly').objectStore(this._tableName);
            const openCursorRequest = store.openKeyCursor ? store.openKeyCursor(query, 'prev') : store.openCursor(query, 'prev');
            openCursorRequest.onsuccess = () => resolve(openCursorRequest.result ? openCursorRequest.result.primaryKey : undefined);
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of the object whose primary key is minimal for the given range.
     * If the optional query is not given, it returns the object whose key is minimal.
     * If the query is of type KeyRange, it returns the object whose primary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    async minValue(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const openCursorRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .openCursor(query, 'next');
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                resolve(cursor ? this.decode(cursor.value, cursor.primaryKey) : undefined);
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of the key being minimal for the given range.
     * If the optional query is not given, it returns the minimal key.
     * If the query is of type KeyRange, it returns the key being minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    async minKey(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const store = db.transaction([this._tableName], 'readonly').objectStore(this._tableName);
            const openCursorRequest = store.openKeyCursor ? store.openKeyCursor(query, 'next') : store.openCursor(query, 'next');
            openCursorRequest.onsuccess = () => resolve(openCursorRequest.result ? openCursorRequest.result.primaryKey : undefined);
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns the count of entries in the given range.
     * If the optional query is not given, it returns the count of entries in the object store.
     * If the query is of type KeyRange, it returns the count of entries within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const getRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .count(query);
            getRequest.onsuccess = () => resolve(getRequest.result);
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Returns the index of the given name.
     * If the index does not exist, it returns undefined.
     * @param {string} indexName The name of the requested index.
     * @returns {IIndex} The index associated with the given name.
     */
    index(indexName) {
        return this._indices.get(indexName);
    }

    /** @type {Promise.<IDBDatabase>} The underlying IDBDatabase. */
    get backend() {
        return this._db.backend;
    }

    /** @type {string} The own table name. */
    get tableName() {
        return this._tableName;
    }

    /**
     * Internally applies a transaction to the store's state.
     * This needs to be done in batch (as a db level transaction), i.e., either the full state is updated
     * or no changes are applied.
     * @param {Transaction} tx The transaction to apply.
     * @returns {Promise} The promise resolves after applying the transaction.
     * @protected
     */
    async _apply(tx) {
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const idbTx = db.transaction([this._tableName], 'readwrite');
            const objSt = idbTx.objectStore(this._tableName);

            if (tx._truncated) {
                objSt.clear();
            }
            for (const key of tx._removed) {
                objSt.delete(key);
            }
            for (const [key, value] of tx._modified) {
                objSt.put(this.encode(value), key);
            }

            idbTx.oncomplete = () => resolve(true);
            idbTx.onerror = reject;
            idbTx.onabort = reject;
        });
    }

    /**
     * Empties the object store.
     * @returns {Promise} The promise resolves after emptying the object store.
     */
    async truncate() {
        const db = this._backend;
        return new Promise((resolve, reject) => {
            const getRequest = db.transaction([this._tableName], 'readonly')
                .objectStore(this._tableName)
                .clear();
            getRequest.onsuccess = resolve;
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * Creates a new secondary index on the object store.
     * Currently, all secondary indices are non-unique.
     * They are defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * Secondary indices may be multiEntry, i.e., if the keyPath resolves to an iterable object, each item within can
     * be used to find this entry.
     * If a new object does not possess the key path associated with that index, it is simply ignored.
     *
     * This function may only be called before the database is connected.
     * Moreover, it is only executed on database version updates or on first creation.
     * @param {string} indexName The name of the index.
     * @param {string|Array.<string>} [keyPath] The path to the key within the object. May be an array for multiple levels.
     * @param {boolean} [multiEntry]
     */
    createIndex(indexName, keyPath, multiEntry=false) {
        if (this._db.connected) throw new Error('Cannot create index while connected');
        keyPath = keyPath || indexName;
        const index = new PersistentIndex(this, indexName, keyPath, multiEntry);
        this._indices.set(indexName, index);
    }

    /**
     * Deletes a secondary index from the object store.
     * @param indexName
     * @returns {Promise} The promise resolves after deleting the index.
     */
    async deleteIndex(indexName) {
        if (this._db.connected) throw new Error('Cannot delete index while connected');
        this._indicesToDelete.push(indexName);
    }

    /**
     * Closes the object store and potential connections.
     * @returns {Promise} The promise resolves after closing the object store.
     */
    close() {
        // Nothing to do here, it is all done on the DB level.
        return this._db.close();
    }

    /**
     * Returns the necessary information in order to flush a combined transaction.
     * @param {Transaction} tx The transaction that should be applied to this backend.
     * @returns {Promise.<EncodedTransaction>} A special transaction object bundling all necessary information.
     */
    async applyCombined(tx) {
        const encodedTx = new EncodedTransaction(this._tableName);

        if (tx._truncated) {
            encodedTx.truncate();
        }

        for (const key of tx._removed) {
            encodedTx.remove(key);
        }
        for (const [key, value] of tx._modified) {
            encodedTx.put(key, this.encode(value));
        }
        return encodedTx;
    }
}
Class.register(IDBBackend);

/**
 * @implements {IJungleDB}
 */
class JungleDB {
    /**
     * Initiates a new database connection. All changes to the database structure
     * require an increase in the version number.
     * Whenever new object stores need to be created, old ones deleted,
     * or indices created/deleted, the dbVersion number has to be increased.
     * When the version number increases, the given function onUpgradeNeeded is called
     * after modifying the database structure.
     * @param {string} name The name of the database.
     * @param {number} dbVersion The current version of the database.
     * @param {function()} [onUpgradeNeeded] A function to be called after upgrades of the structure.
     */
    constructor(name, dbVersion, onUpgradeNeeded) {
        if (dbVersion <= 0) throw new Error('The version provided must not be less or equal to 0');
        this._databaseDir = name;
        this._dbVersion = dbVersion;
        this._onUpgradeNeeded = onUpgradeNeeded;
        this._connected = false;
        this._objectStores = new Map();
        this._objectStoreBackends = new Map();
        this._objectStoresToDelete = [];
    }

    /**
     * @type {IDBFactory} The browser's IDB factory.
     * @private
     */
    get _indexedDB() {
        return window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB || window.OIndexedDB || window.msIndexedDB;
    }

    /**
     * Connects to the indexedDB.
     * @returns {Promise.<IDBDatabase>} A promise resolving on successful connection.
     * The raw IDBDatabase object should not be used.
     */
    connect() {
        if (this._db) return Promise.resolve(this._db);

        const request = this._indexedDB.open(this._databaseDir, this._dbVersion);
        const that = this;

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                that._connected = true;
                that._db = request.result;
                resolve(request.result);
            };

            request.onerror = reject;
            request.onupgradeneeded = event => that._initDB(event);
        });
    }

    /**
     * Internal method that is called when a db upgrade is required.
     * @param {*} event The obupgradeneeded event.
     * @returns {Promise.<void>} A promise that resolves after successful completion.
     * @private
     */
    async _initDB(event) {
        const db = event.target.result;

        // Delete existing ObjectStores.
        for (const tableName of this._objectStoresToDelete) {
            db.deleteObjectStore(tableName);
        }
        delete this._objectStoresToDelete;

        // Create new ObjectStores.
        for (const [tableName, objStore] of this._objectStoreBackends) {
            const IDBobjStore = db.createObjectStore(tableName);
            // Create indices.
            objStore.init(IDBobjStore);
        }
        delete this._objectStoreBackends;

        // Call user defined function if requested.
        if (this._onUpgradeNeeded) {
            await this._onUpgradeNeeded();
        }
    }

    /** @type {IDBDatabase} The underlying IDBDatabase. */
    get backend() {
        return this._db;
    }

    /** @type {boolean} Whether a connection is established. */
    get connected() {
        return this._connected;
    }

    /**
     * Returns the ObjectStore object for a given table name.
     * @param {string} tableName The table name to access.
     * @returns {ObjectStore} The ObjectStore object.
     */
    getObjectStore(tableName) {
        return this._objectStores.get(tableName);
    }

    /**
     * Creates a volatile object store (non-persistent).
     * @param {ICodec} [codec] A codec for the object store.
     * @returns {IObjectStore}
     */
    static createVolatileObjectStore(codec=null) {
        return new ObjectStore(new InMemoryBackend('', codec), null);
    }

    /**
     * Creates a new object store (and allows to access it).
     * This method always has to be called before connecting to the database.
     * If it is not called, the object store will not be accessible afterwards.
     * If a call is newly introduced, but the database version did not change,
     * the table does not exist yet.
     * @param {string} tableName The name of the object store.
     * @param {ICodec} [codec] A codec for the object store.
     * @param {boolean} [persistent] If set to false, this object store is not persistent.
     * @returns {IObjectStore}
     */
    createObjectStore(tableName, codec=null, persistent=true) {
        if (this._connected) throw new Error('Cannot create ObjectStore while connected');
        if (this._objectStores.has(tableName)) {
            return this._objectStores.get(tableName);
        }
        const backend = persistent
            ? new IDBBackend(this, tableName, codec)
            : new InMemoryBackend(tableName, codec);
        const cachedBackend = new CachedBackend(backend);
        const objStore = new ObjectStore(cachedBackend, this);
        this._objectStores.set(tableName, objStore);
        this._objectStoreBackends.set(tableName, backend);
        return objStore;
    }

    /**
     * Deletes an object store.
     * This method has to be called before connecting to the database.
     * @param {string} tableName
     */
    async deleteObjectStore(tableName) {
        if (this._connected) throw new Error('Cannot delete ObjectStore while connected');
        this._objectStoresToDelete.push(tableName);
    }

    /**
     * Closes the database connection.
     * @returns {Promise} The promise resolves after closing the database.
     */
    async close() {
        if (this._connected) {
            this._connected = false;
            this.backend.close();
        }
    }

    /**
     * Fully deletes the database.
     * @returns {Promise} The promise resolves after deleting the database.
     */
    async destroy() {
        await this.close();
        return new Promise((resolve, reject) => {
            const req = this._indexedDB.deleteDatabase(this._databaseDir);
            req.onsuccess = resolve;
            req.onerror = reject;
        });
    }

    /**
     * Is used to commit multiple transactions atomically.
     * This guarantees that either all transactions are written or none.
     * The method takes a list of transactions (at least two transactions).
     * If the commit was successful, the method returns true, and false otherwise.
     * @param {Transaction|CombinedTransaction} tx1 The first transaction
     * (a CombinedTransaction object is only used internally).
     * @param {Transaction} tx2 The second transaction.
     * @param {...Transaction} txs A list of further transactions to commit together.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    static async commitCombined(tx1, tx2, ...txs) {
        // If tx1 is a CombinedTransaction, flush it to the database.
        if (tx1 instanceof CombinedTransaction) {
            const functions = [];
            /** @type {Array.<EncodedTransaction>} */
            const encodedTxs = [];
            const tableNames = [];

            const infos = await Promise.all(tx1.transactions.map(tx => tx.objectStore._backend.applyCombined(tx)));
            for (const info of infos) {
                let tmp = info;
                if (!Array.isArray(info)) {
                    tmp = [info];
                }
                for (const innerInfo of tmp) {
                    if (typeof innerInfo === 'function') {
                        functions.push(innerInfo);
                    } else {
                        encodedTxs.push(innerInfo);
                        tableNames.push(innerInfo.tableName);
                    }
                }
            }

            const db = tx1.backend !== null ? tx1.backend.backend : null;
            return new Promise((resolve, reject) => {
                if (tableNames.length > 0) {
                    const idbTx = db.transaction(tableNames, 'readwrite');

                    for (const encodedTx of encodedTxs) {
                        const objSt = idbTx.objectStore(encodedTx.tableName);

                        if (encodedTx.truncated) {
                            objSt.clear();
                        }
                        for (const key of encodedTx.removed) {
                            objSt.delete(key);
                        }
                        for (const [key, value] of encodedTx.modified) {
                            objSt.put(value, key);
                        }
                    }

                    idbTx.oncomplete = () => {
                        Promise.all(functions.map(f => f())).then(() => {
                            resolve(true);
                        });
                    };
                    idbTx.onerror = reject;
                    idbTx.onabort = reject;
                } else {
                    Promise.all(functions.map(f => f())).then(() => {
                        resolve(true);
                    });
                }
            });
        }
        txs.push(tx1);
        txs.push(tx2);
        if (!txs.every(tx => tx instanceof Transaction)) {
            throw new Error('Invalid arguments supplied');
        }
        const ctx = new CombinedTransaction(...txs);
        return ctx.commit();
    }

    toString() {
        return `JungleDB{name=${this._databaseDir}}`;
    }
}
Class.register(JungleDB);

/**
 * This class represents a wrapper around the IndexedDB indices.
 * @implements {IIndex}
 */
class PersistentIndex {
    /**
     * @param {IDBBackend} objectStore
     * @param {string} indexName
     * @param {string|Array.<string>} keyPath
     * @param {boolean} multiEntry
     */
    constructor(objectStore, indexName, keyPath, multiEntry=false) {
        this._objectStore = objectStore;
        this._indexName = indexName;
        this._keyPath = keyPath;
        this._multiEntry = multiEntry;
    }

    /**
     * Reinitialises the index.
     * @returns {Promise} The promise resolves after emptying the index.
     */
    async truncate() {
        // Will automatically be truncated.
    }

    /**
     * The key path associated with this index.
     * A key path is defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * @type {string|Array.<string>}
     */
    get keyPath() {
        return this._keyPath;
    }

    /**
     * This value determines whether the index supports multiple secondary keys per entry.
     * If so, the value at the key path is considered to be an iterable.
     * @type {boolean}
     */
    get multiEntry() {
        return this._multiEntry;
    }

    /**
     * Internal method to access IDB index.
     * @param {IDBDatabase} db The indexed DB.
     * @returns {IDBIndex} The indexedDB's index object.
     * @private
     */
    _index(db) {
        return db.transaction([this._objectStore.tableName], 'readonly')
            .objectStore(this._objectStore.tableName)
            .index(this._indexName);
    }

    /**
     * Returns a promise of an array of objects whose secondary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the index.
     * If the query is of type KeyRange, it returns all objects whose secondary keys are within this range.
     * @param {KeyRange} [query] Optional query to check secondary keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    async values(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = [];
            const request = this._index(db).openCursor(query);
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    results.push(this._objectStore.decode(cursor.value, cursor.primaryKey));
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Returns a promise of a set of primary keys, whose associated objects' secondary keys are in the given range.
     * If the optional query is not given, it returns all primary keys in the index.
     * If the query is of type KeyRange, it returns all primary keys for which the secondary key is within this range.
     * @param {KeyRange} [query] Optional query to check the secondary keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of primary keys relevant to the query.
     */
    async keys(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = new Set();
            const index = this._index(db);
            const openCursorRequest = index.openKeyCursor ? index.openKeyCursor(query) : index.openCursor(query);
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    results.add(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    /**
     * Returns a promise of an array of objects whose secondary key is maximal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async maxValues(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = [];
            let maxKey = null;
            const request = this._index(db).openCursor(query, 'prev');
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (maxKey === null) {
                    maxKey = cursor.key;
                }
                // Only iterate until key changes.
                if (cursor && maxKey === cursor.key) {
                    results.push(this._objectStore.decode(cursor.value, cursor.primaryKey));
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are maximal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async maxKeys(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = new Set();
            let maxKey = null;
            const index = this._index(db);
            const request = index.openKeyCursor ? index.openKeyCursor(query, 'prev') : index.openCursor(query, 'prev');
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (maxKey === null) {
                    maxKey = cursor.key;
                }
                // Only iterate until key changes.
                if (cursor && maxKey === cursor.key) {
                    results.add(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Returns a promise of an array of objects whose secondary key is minimal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async minValues(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = [];
            let maxKey = null;
            const request = this._index(db).openCursor(query, 'next');
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (maxKey === null) {
                    maxKey = cursor.key;
                }
                // Only iterate until key changes.
                if (cursor && maxKey === cursor.key) {
                    results.push(this._objectStore.decode(cursor.value, cursor.primaryKey));
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are minimal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async minKeys(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const results = new Set();
            let maxKey = null;
            const index = this._index(db);
            const request = index.openKeyCursor ? index.openKeyCursor(query, 'next') : index.openCursor(query, 'next');
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (maxKey === null) {
                    maxKey = cursor.key;
                }
                // Only iterate until key changes.
                if (cursor && maxKey === cursor.key) {
                    results.add(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Returns the count of entries, whose secondary key is in the given range.
     * If the optional query is not given, it returns the count of entries in the index.
     * If the query is of type KeyRange, it returns the count of entries, whose secondary key is within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        query = IDBTools.convertKeyRange(query);
        const db = await this._objectStore.backend;
        return new Promise((resolve, reject) => {
            const request = this._index(db).count(query);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}
Class.register(PersistentIndex);


/**
 * Returns an iterator over an array in a specific direction.
 * It does *not* handle or reflect changes of the array while iterating it.
 * @memberOf Array
 * @param {boolean} ascending Whether to traverse the array in ascending direction.
 * @returns {{next:function():*, peek:function():*, hasNext:function():boolean}} An iterator.
 */
Array.prototype.iterator = function(ascending=true) {
    let nextIndex = ascending ? 0 : this.length-1;

    return {
        next: () => {
            return nextIndex >= 0 && nextIndex < this.length ?
                this[ascending ? nextIndex++ : nextIndex--] : undefined;
        },
        hasNext: () => {
            return nextIndex >= 0 && nextIndex < this.length;
        },
        peek: () => {
            return nextIndex >= 0 && nextIndex < this.length ?
                this[nextIndex] : undefined;
        }
    };
};

/*
 B+ Tree processing
 Version 2.0.0
 Based on code by Graham O'Neill, April 2013
 Modified by Pascal Berrang, July 2017

 ------------------------------------------------------------------------------

 Copyright (c) 2017 Graham O'Neill & Pascal Berrang

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.

 ------------------------------------------------------------------------------

 */

/**
 * This abstract class describes a general Node within a B+Tree.
 * Each node owns an array of keys and has an id.
 */
class Node {
    /**
     * Creates a new node.
     * @param {number} id The node's id.
     * @param {Array.<*>} [keys] Optional array of keys (default is empty).
     */
    constructor(id, keys=[]) {
        this._keys = keys;
        this._id = id;
    }

    /**
     * @type {number} The id of the node.
     */
    get id() {
        return this._id;
    }

    /**
     * @type {Array.<*>} The array of keys.
     */
    get keys() {
        return this._keys;
    }

    /**
     * Converts a node to JSON, which is necessary to persist the B+Tree.
     * @returns {{_id: number, _keys: Array.<*>}} The JSON representation.
     */
    toJSON() {
        return {
            _id: this._id,
            _keys: this._keys
        };
    }

    /**
     * Constructs a node from a JSON object.
     * @param {{isLeaf: boolean, _id: number, _keys: Array.<*>}} o The JSON object to build the node from.
     * @returns {Node} The constructed node.
     */
    static fromJSON(o) {
        if (o.isLeaf === true) {
            return LeafNode.fromJSON(o);
        } else if (o.isLeaf === false) {
            return InnerNode.fromJSON(o);
        }
        return undefined;
    }
}
Class.register(Node);

/**
 * A Leaf Node in the B+Tree.
 * @extends Node
 */
class LeafNode extends Node {
    /**
     * Creates a new leaf node.
     * Leaf nodes store key value pairs,
     * hence the keys and records arrays are required to have the same length.
     * In an index, the keys array usually stores the secondary key,
     * while the records array stores the corresponding primary key.
     * The B+Tree ensures that the items in the keys array are ordered ascending.
     * @param {number} id The node's id.
     * @param {Array.<*>} [keys] Optional array of keys (default is empty).
     * @param {Array.<*>} [records] Optional array of records (default is empty).
     */
    constructor(id, keys=[], records=[]) {
        if (keys.length !== records.length) {
            throw new Error('Keys and records must have the same length');
        }
        super(id, keys);
        this._records = records;
        this.prevLeaf = null;
        this.nextLeaf = null;
    }

    /**
     * @type {Array.<*>} The list of records associated with the keys.
     */
    get records() {
        return this._records;
    }

    /**
     * Returns whether this is a leaf node.
     * @returns {boolean} True, since it is a leaf node.
     */
    isLeaf() {
        return true;
    }

    /**
     * Converts a node to JSON, which is necessary to persist the B+Tree.
     * @returns {{_id: number, _keys: Array.<*>, _records: Array.<*>, isLeaf: boolean, prevLeaf: number, nextLeaf: number}} The JSON representation.
     */
    toJSON() {
        const o = super.toJSON();
        o.isLeaf = true;
        o._records = this._records;
        o.prevLeaf = this.prevLeaf ? this.prevLeaf.id : this.prevLeaf;
        o.nextLeaf = this.nextLeaf ? this.nextLeaf.id : this.nextLeaf;
        return o;
    }

    /**
     * Constructs a node from a JSON object.
     * @param {{_id: number, _keys: Array.<*>, _records: Array.<*>, isLeaf: boolean, prevLeaf: number, nextLeaf: number}} o The JSON object to build the node from.
     * @returns {Node} The constructed node.
     */
    static fromJSON(o) {
        const leaf = new LeafNode(o._id, o._keys, o._records);
        leaf.prevLeaf = o.prevLeaf;
        leaf.nextLeaf = o.nextLeaf;
        return leaf;
    }

    /**
     * Searches the node for a specific key and returns its position if found.
     * The near parameter allows to find either an exact match or the first key
     * greater/less or equal than the specified key.
     *
     * Since the B+tree limits the number of records per leaf node,
     * the complexity of this method is in O([order/2, order-1]).
     * @param {*} key The key to look for.
     * @param {BTree.NEAR_MODE} near
     * @returns {number} The index of the match if found, -1 otherwise.
     */
    getItem(key, near) {
        const keys = this._keys;
        // Find item matching the query.
        if (near === BTree.NEAR_MODE.GE) {
            for (let i=0, len=keys.length; i<len; ++i) {
                if (key <= keys[i]) return i;
            }
        } else if (near === BTree.NEAR_MODE.LE) {
            for (let i=keys.length - 1; i>=0; --i) {
                if (key >= keys[i]) return i;
            }
        } else {
            for (let i=0, len=keys.length; i<len; ++i) {
                if (key === keys[i]) return i;
            }
        }
        return -1;
    }

    /**
     * Adds a key, record pair to this leaf node.
     * By definition, the key is inserted into the keys of this leaf node,
     * such that the ascending order of the keys is maintained.
     * @param {*} key The key to insert.
     * @param {*} record The corresponding record to insert.
     * @returns {number} The position it was inserted at.
     */
    addKey(key, record) {
        let insertPos = this._keys.length;
        // Find position to insert.
        for (let i=0, len=insertPos; i<len; ++i) {
            // Key already exists.
            if (key === this._keys[i]) {
                return -1;
            }
            // Update potential position.
            if (key <= this._keys[i]) {
                insertPos = i;
                break;
            }
        }
        // Insert key/record.
        this._keys.splice(insertPos, 0, key);
        this._records.splice(insertPos, 0, record);
        return insertPos;
    }

    /**
     * Splits the leaf node into two nodes (this + one new node).
     * The resulting nodes should have almost equal sizes.
     * The new node will return the upper half of the previous entries.
     * @param {number} newId The id to be assigned the new node.
     * @returns {LeafNode} The new leaf node containing the upper half of entries.
     */
    split(newId) {
        const mov = Math.floor(this._keys.length/2);
        const newKeys = [], newRecords = [];
        for (let i = 0; i < mov; ++i) {
            newKeys.unshift(this._keys.pop());
            newRecords.unshift(this._records.pop());
        }
        const newL = new LeafNode(newId, newKeys, newRecords);
        newL.prevLeaf = this;
        newL.nextLeaf = this.nextLeaf;
        if (this.nextLeaf !== null) this.nextLeaf.prevLeaf = newL;
        this.nextLeaf = newL;
        return newL;
    }

    /**
     * Merges two leaf nodes together (this + frNod).
     * The given node frNod is no longer connected afterwards.
     * @param {LeafNode} frNod The node to merge with.
     * @param {InnerNode} paNod The parent node that needs to be updated.
     * @param {*} frKey The key of the old leaf in the parent.
     */
    merge(frNod, paNod, frKey) {
        // Append keys/records.
        for (let i=0, len=frNod.keys.length; i<len; ++i) {
            this._keys.push(frNod.keys[i]);
            this._records.push(frNod.records[i]);
        }
        // Update leaf pointers.
        this.nextLeaf = frNod.nextLeaf;
        if (frNod.nextLeaf !== null) frNod.nextLeaf.prevLeaf = this;
        frNod.prevLeaf = null;
        frNod.nextLeaf = null;
        // Update parent: find position of old leaf.
        let pos = paNod.keys.length-1;
        for (let i=pos; i>=0; --i) {
            if (paNod.keys[i] === frKey) {
                pos = i;
                break;
            }
        }
        // Delete old key from parent.
        paNod.keys.splice(pos, 1);
        paNod.nodePointers.splice(pos+1, 1);
    }

}
Class.register(LeafNode);

/**
 * An Inner Node in the B+Tree.
 * @extends Node
 */
class InnerNode extends Node {
    /**
     * Creates a new inner node.
     * The only key values that appear in the internal nodes are the first key values from each leaf,
     * with the exception of the key from the very first leaf which isn't included.
     * Each key value that appears in the internal nodes only appears once.
     * @param {number} id The node's id.
     * @param {Array.<*>} [keys] The first key of each child node (except for the first one).
     * @param {Array.<Node>} [nodePointers] The pointers to the child nodes.
     */
    constructor(id, keys=[], nodePointers=[]) {
        super(id, keys);
        this._nodePointers = nodePointers;
    }

    /**
     * Returns whether this is a leaf node.
     * @returns {boolean} False, since it is an inner node.
     */
    isLeaf() {
        return false;
    }

    /**
     * @type {Array.<Node>} The pointers to the children.
     */
    get nodePointers() {
        return this._nodePointers;
    }

    /**
     * Converts a node to JSON, which is necessary to persist the B+Tree.
     * @returns {{_id: number, _keys: Array.<*>, isLeaf: boolean, _nodePointers: Array.<number>}} The JSON representation.
     */
    toJSON() {
        const o = super.toJSON();
        const nodePointers = [];
        for (let i=0; i<this._nodePointers.length; ++i) {
            nodePointers.push(this._nodePointers[i] ? this._nodePointers[i].id : this._nodePointers[i]);
        }
        o.isLeaf = false;
        o._nodePointers = nodePointers;
        return o;
    }

    /**
     * Constructs a node from a JSON object.
     * @param {{_id: number, _keys: Array.<*>, isLeaf: boolean, _nodePointers: Array.<number>}} o The JSON object to build the node from.
     * @returns {Node} The constructed node.
     */
    static fromJSON(o) {
        return new InnerNode(o._id, o._keys, o._nodePointers);
    }

    /**
     * Searches the node for a specific key and returns the matching child's position.
     *
     * Since the B+tree limits the number of records per leaf node,
     * the complexity of this method is in O([(order-1)/2, order-1]).
     * @param {*} key The key to look for.
     * @returns {number} The index of the match.
     */
    getItem(key) {
        const len = this._keys.length;
        for (let i=0; i<len; ++i) {
            if (key < this._keys[i]) return i;
        }
        return this._keys.length;
    }

    /**
     * Adds a key corresponding to a new child node to this inner node.
     * By definition, the key is inserted into the keys of this leaf node,
     * such that the ascending order of the keys is maintained.
     * @param {*} key The key to insert.
     * @param {Node} ptrL The pointer to the corresponding child node.
     * @param {Node} ptrR The pointer to the node right of the child node.
     * @returns {number} The position it was inserted at.
     */
    addKey(key, ptrL, ptrR) {
        const len = this._keys.length;
        let insertPos = len;
        // Find position to insert.
        for (let i=0; i<len; ++i) {
            if (key <= this._keys[i]) {
                insertPos = i;
                break;
            }
        }
        // Update keys and pointers.
        this._keys.splice(insertPos, 0, key);
        this._nodePointers.splice(insertPos, 0, ptrL);
        this._nodePointers[insertPos+1] = ptrR;
    }

    /**
     * Splits the node into two nodes (this + one new node).
     * The resulting nodes should have almost equal sizes.
     * The new node will return the upper half of the previous entries.
     * @param {number} newId The id to be assigned the new node.
     * @returns {InnerNode} The new inner node containing the upper half of entries.
     */
    split(newId) {
        const mov = Math.ceil(this._keys.length/2) - 1;
        const newNodePointers = [this._nodePointers.pop()];
        const newKeys = [];
        for (let i=mov-1; i>=0; --i) {
            newKeys.unshift(this._keys.pop());
            newNodePointers.unshift(this._nodePointers.pop());
        }
        return new InnerNode(newId, newKeys, newNodePointers);
    }

    /**
     * Merges two inner nodes together (this + frNod).
     * The given node frNod is no longer connected afterwards.
     * @param {InnerNode} frNod The node to merge with.
     * @param {InnerNode} paNod The parent node that needs to be updated.
     * @param {number} paItm The position in the parent.
     */
    merge(frNod, paNod, paItm) {
        const del = paNod.keys[paItm];
        // Add key from parent.
        this._keys.push(del);
        // Add keys and nodePointers from merged node.
        for (let i=0, len=frNod.keys.length; i<len; ++i) {
            this._keys.push(frNod.keys[i]);
            this._nodePointers.push(frNod.nodePointers[i]);
        }
        // Add last nodePointer as well.
        this._nodePointers.push(frNod.nodePointers[frNod.nodePointers.length-1]);
        paNod.keys.splice(paItm, 1); // Delete old key from parent.
        paNod.nodePointers.splice(paItm+1, 1); // Delete old pointer from parent.
        return del;
    }
}
Class.register(InnerNode);

/**
 * The actual BTree implementation.
 * @implements {IBTree}
 */
class BTree {
    /**
     * Creates a new BTree of a given order.
     * The order specifies how many entries a single node can contain.
     * A leaf node generally contains [order/2, order-1] entries,
     * while an inner node contains [(order-1)/2, order-1] entries.
     * @param {number} order The order of the tree.
     */
    constructor(order=7) {
        this._nodeId = 0; // Needed for persistence.
        this._root = new LeafNode(this._nodeId++);
        this._maxkey = order-1;
        this._minkyl = Math.floor(order/2);
        this._minkyn = Math.floor(this._maxkey/2);
        this._leaf = null;
        this._item = -1;

        this._key = null;
        this._record = null;
        this._length = 0;
        this._eof = true;
        this._found = false;
    }

    /**
     * The total number of records.
     * Note that if the record is a list/set of records, these are not counted.
     * @type {number}
     */
    get length() {
        return this._length;
    }

    /**
     * The current key as returned by any operation.
     * It is null if there is no matching record.
     * @type {*}
     */
    get currentKey() {
        return this._key;
    }

    /**
     * The current record as returned by any operation.
     * It is null if there is no matching record.
     * @type {*}
     */
    get currentRecord() {
        return this._record;
    }

    /**
     * Creates a new TreeTransaction object on this tree.
     * A tree transaction keeps track of the changed nodes and entries,
     * so that these can be updated in a permanent storage.
     * @returns {TreeTransaction}
     */
    transaction() {
        return new TreeTransaction(this);
    }

    /**
     * Inserts a new key-record pair into the BTree, if there is no entry for that key.
     * The current record and current key are set to the new entry in case of success
     * or the existing entry if present.
     * @param {*} key The unique key for the record.
     * @param {*} rec The record associated with the key.
     * @param [modified] The optional set of modified nodes (will be updated by the method).
     * @returns {boolean} True if the record was inserted, false if there was already a record with that key.
     */
    insert(key, rec, modified=null) {
        const stack = [];
        this._leaf = this._root;
        while (!this._leaf.isLeaf()) {
            stack.push(this._leaf);
            this._item = this._leaf.getItem(key);
            this._leaf = this._leaf.nodePointers[this._item];
        }
        this._item = this._leaf.addKey(key, rec);
        this._key = key;
        this._eof = false;
        if (this._item === -1) {
            this._found = true;
            this._item = this._leaf.getItem(key, false);
            this._record = this._leaf.records[this._item];
        } else {
            BTree._modifyNode(modified, this._leaf);

            this._found = false;
            this._record = rec;
            this._length++;
            if (this._leaf.keys.length > this._maxkey) {
                let pL = this._leaf;
                let pR = this._leaf.split(this._nodeId++);
                BTree._modifyNode(modified, pL); // we splitted nodes
                BTree._modifyNode(modified, pR);
                let ky = pR.keys[0];
                this._item = this._leaf.getItem(key, false);
                if (this._item === -1) {
                    this._leaf = this._leaf.nextLeaf;
                    this._item = this._leaf.getItem(key, false);
                }
                while (true) { // eslint-disable-line no-constant-condition
                    if (stack.length === 0) {
                        const newN = new InnerNode(this._nodeId++);
                        newN.keys[0] = ky;
                        newN.nodePointers[0] = pL;
                        newN.nodePointers[1] = pR;
                        BTree._modifyNode(modified, newN);
                        this._root = newN;
                        break;
                    }
                    const nod = stack.pop();
                    nod.addKey(ky, pL, pR);
                    BTree._modifyNode(modified, nod);
                    if (nod.keys.length <= this._maxkey) break;
                    pL = nod;
                    pR = nod.split(this._nodeId++);
                    BTree._modifyNode(modified, pL);
                    BTree._modifyNode(modified, pR);
                    ky = nod.keys.pop();
                }
            }
        }
        return (!this._found);
    }

    /**
     * Removes a key-record pair from the BTree.
     * In case of successful deletion, the current record and key will be set to the next entry greater or equal.
     * If no record was found, they will be reset to null.
     * @param {*} key The unique key for the record.
     * @param [modified] The optional set of modified nodes (will be updated by the method).
     * @param [removed] The optional set of removed nodes (will be updated by the method).
     * @returns {boolean} True if the record was deleted, false if there is no such record.
     */
    remove(key, modified=null, removed=null) {
        if (typeof key === 'undefined') {
            if (this._item === -1) {
                this._eof = true;
                this._found = false;
                return false;
            }
            key = this._leaf.keys[this._item];
        }
        this._del(key, modified, removed);
        if (!this._found) {
            this._item = -1;
            this._eof = true;
            this._key = null;
            this._record = null;
        } else {
            this.seek(key, BTree.NEAR_MODE.GE);
            this._found = true;
        }
        return (this._found);
    }

    /**
     * Searches the tree for a specific key and advances the current key/record pointers if found.
     * By default only an exact key match is found, but the near parameter also allows to advance to the next entry
     * greater/less or equal than the specified key.
     * @param {*} key The key to look for.
     * @param {BTree.NEAR_MODE} [near] Optional parameter, specifies to look for a key k' =/≤/≥ key.
     * @returns {boolean} True if such a key was found, false otherwise.
     */
    seek(key, near=BTree.NEAR_MODE.NONE) {
        this._leaf = this._root;
        while (!this._leaf.isLeaf()) {
            this._item = this._leaf.getItem(key);
            this._leaf = this._leaf.nodePointers[this._item];
        }
        this._item = this._leaf.getItem(key, near);
        if (near === BTree.NEAR_MODE.GE && this._item === -1 && this._leaf.nextLeaf !== null) {
            this._leaf = this._leaf.nextLeaf;
            this._item = 0;
        }
        if (near === BTree.NEAR_MODE.LE && this._item === -1 && this._leaf.prevLeaf !== null) {
            this._leaf = this._leaf.prevLeaf;
            this._item = this._leaf.records.length - 1;
        }
        if (this._item === -1) {
            this._eof = true;
            this._key = null;
            this._found = false;
            this._record = null;
        } else {
            this._eof = false;
            this._found = (this._leaf.keys[this._item] === key);
            this._key = this._leaf.keys[this._item];
            this._record = this._leaf.records[this._item];
        }
        return (!this._eof);
    }

    /**
     * Advances the current key/record pointers by a given number of steps.
     * Default is advancing by 1, which means the next record (the new key will thus be the next larger key).
     * -1 means the previous record (the new key will thus be the next smaller key).
     * @param {number} [cnt] The number of records to advance (may be negative).
     * @returns {boolean} True if there is a record to advance to, false otherwise.
     */
    skip(cnt = 1) {
        if (typeof cnt !== 'number') cnt = 1;
        if (this._item === -1 || this._leaf === null) this._eof = true;
        if (cnt > 0) {
            while (!this._eof && this._leaf.keys.length - this._item - 1 < cnt) {
                cnt = cnt - this._leaf.keys.length + this._item;
                this._leaf = this._leaf.nextLeaf;
                if (this._leaf === null) {
                    this._eof = true;
                } else {
                    this._item = 0;
                }
            }
            if (!this._eof) this._item = this._item + cnt;
        } else {
            cnt = -cnt;
            while (!this._eof && this._item < cnt) {
                cnt = cnt - this._item - 1;
                this._leaf = this._leaf.prevLeaf;
                if (this._leaf === null) {
                    this._eof = true;
                } else {
                    this._item = this._leaf.keys.length-1;
                }
            }
            if (!this._eof) {
                this._item = this._item - cnt;
            }
        }
        if (this._eof) {
            this._item = -1;
            this._found = false;
            this._key = null;
            this._record = null;
        } else {
            this._found = true;
            this._key = this._leaf.keys[this._item];
            this._record = this._leaf.records[this._item];
        }
        return (this._found);
    }

    /**
     * Jumps to the cnt entry starting from the smallest key (i.e., leftmost leaf, first entry) if cnt > 0.
     * If cnt < 0, it jumps to the cnt entry starting from the largest key (i.e., rightmost leaf, last entry).
     * @param {number} [cnt] The record to jump to (may be negative).
     * @returns {boolean} True if there is a record to jump to, false otherwise.
     */
    goto(cnt) {
        if (cnt < 0) {
            this.goBottom();
            if (!this._eof) this.skip(cnt+1);
        } else {
            this.goTop();
            if (!this._eof) this.skip(cnt-1);
        }
        return (this._found);
    }

    /**
     * Returns the index of the current entry (key/record) in a sorted list of all entries.
     * For the B+ Tree, this is done by traversing the leafs from the leftmost leaf, first entry
     * until the respective key is found.
     * @returns {number} The entry position.
     */
    keynum() {
        if (this._leaf === null || this._item === -1) return -1;
        let cnt = this._item + 1;
        let ptr = this._leaf;
        while (ptr.prevLeaf !== null) {
            ptr = ptr.prevLeaf;
            cnt += ptr.keys.length;
        }
        return cnt;
    }

    /**
     * Jumps to the smallest key's entry (i.e., leftmost leaf, first entry).
     * False will only be returned if the tree is completely empty.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goTop() {
        this._leaf = this._root;
        while (!this._leaf.isLeaf()) {
            this._leaf = this._leaf.nodePointers[0];
        }
        if (this._leaf.keys.length === 0) {
            this._item = -1;
            this._eof = true;
            this._found = false;
            this._key = null;
            this._record = null;
        } else {
            this._item = 0;
            this._eof = false;
            this._found = true;
            this._key = this._leaf.keys[0];
            this._record = this._leaf.records[0];
        }
        return (this._found);
    }

    /**
     * Jumps to the largest key's entry (i.e., rightmost leaf, last entry).
     * False will only be returned if the tree is completely empty.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goBottom() {
        this._leaf = this._root;
        while (!this._leaf.isLeaf()) {
            this._leaf = this._leaf.nodePointers[this._leaf.nodePointers.length-1];
        }
        if (this._leaf.keys.length === 0) {
            this._item = -1;
            this._eof = true;
            this._found = false;
            this._key = null;
            this._record = null;
        } else {
            this._item = this._leaf.keys.length-1;
            this._eof = false;
            this._found = true;
            this._key = this._leaf.keys[this._item];
            this._record = this._leaf.records[this._item];
        }
        return (this._found);
    }

    /**
     * Rebuilds/balances the whole tree.
     * Inserting and deleting keys into a tree will result
     * in some leaves and nodes having the minimum number of keys allowed.
     * This routine will ensure that each leaf and node has as many keys as possible,
     * resulting in a denser, flatter tree.
     * False is only returned if the tree is completely empty.
     * @returns {boolean} True if the tree is not completely empty.
     */
    pack(modified=null) {
        let len;
        let i;
        this.goTop(0);
        if (this._leaf === this._root) return false;

        // Pack leaves
        let toN = new LeafNode(this._nodeId++);
        let toI = 0;
        let frN = this._leaf;
        let frI = 0;
        let parKey = [];
        let parNod = [];
        while (true) { // eslint-disable-line no-constant-condition
            BTree._modifyNode(modified, toN);
            BTree._modifyNode(modified, frN);
            toN.keys[toI] = frN.keys[frI];
            toN.records[toI] = frN.records[frI];
            if (toI === 0) parNod.push(toN);
            if (frI === frN.keys.length-1) {
                if (frN.nextLeaf === null) break;
                frN = frN.nextLeaf;
                frI = 0;
            } else {
                frI++;
            }
            if (toI === this._maxkey-1) {
                const tmp = new LeafNode(this._nodeId++);
                toN.nextLeaf = tmp;
                tmp.prevLeaf = toN;
                toN = tmp;
                toI = 0;
            } else {
                toI++;
            }
        }
        let mov = this._minkyl - toN.keys.length;
        frN = toN.prevLeaf;
        if (mov > 0 && frN !== null) {
            BTree._modifyNode(modified, frN);
            // Insert new keys/records.
            for (i = mov-1; i>=0; --i) {
                toN.keys.unshift(frN.keys.pop());
                toN.records.unshift(frN.records.pop());
            }
        }
        for (i=1, len=parNod.length; i<len; ++i) {
            parKey.push(parNod[i].keys[0]);
        }
        parKey[parKey.length] = null;

        // Rebuild nodes
        let kidKey, kidNod;
        while (parKey[0] !== null) {
            kidKey = parKey;
            kidNod = parNod;
            parKey = [];
            parNod = [];
            toI = this._maxkey + 1;
            i = 0;
            len = kidKey.length;
            for (; i<len; i++) {
                if (toI > this._maxkey) {
                    toN = new InnerNode(this._nodeId++);
                    toI = 0;
                    parNod.push(toN);
                }
                toN.keys[toI] = kidKey[i];
                toN.nodePointers[toI] = kidNod[i];
                toI++;
                BTree._modifyNode(modified, toN);
            }
            mov = this._minkyn - toN.keys.length + 1;
            if (mov > 0 && parNod.length > 1) {
                frN = parNod[parNod.length-2];
                BTree._modifyNode(modified, frN);
                for (i = mov-1; i>=0; --i) {
                    toN.keys.unshift(frN.keys.pop());
                    toN.nodePointers.unshift(frN.nodePointers.pop());
                }
            }
            i = 0;
            len = parNod.length;
            for (; i<len; ++i) {
                parKey.push(parNod[i].keys.pop());
            }
        }
        this._root = parNod[0];
        this.goTop();
        return (this._found);
    }

    /**
     * Internal helper method to delete a key from the tree.
     * @param {*} key The unique key for the record.
     * @param [modified] The optional set of modified nodes (will be updated by the method).
     * @param [removed] The optional set of removed nodes (will be updated by the method).
     * @private
     */
    _del(key, modified=null, removed=null) {
        const stack = [];
        let parNod = null;
        let parPtr = -1;
        this._leaf = this._root;
        while (!this._leaf.isLeaf()) {
            stack.push(this._leaf);
            parNod = this._leaf;
            parPtr = this._leaf.getItem(key);
            this._leaf = this._leaf.nodePointers[parPtr];
        }
        this._item = this._leaf.getItem(key,false);

        // Key not in tree
        if (this._item === -1) {
            this._found = false;
            return;
        }
        this._found = true;

        // Delete key from leaf
        this._leaf.keys.splice(this._item, 1);
        this._leaf.records.splice(this._item, 1);
        BTree._modifyNode(modified, this._leaf);
        this._length--;

        // Leaf still valid: done
        if (this._leaf === this._root) {
            return;
        }
        if (this._leaf.keys.length >= this._minkyl) {
            if (this._item === 0) BTree._fixNodes(stack, key, this._leaf.keys[0], modified);
            return;
        }
        let delKey;

        // Steal from left sibling if possible
        let sibL = (parPtr === 0) ? null : parNod.nodePointers[parPtr - 1];
        if (sibL !== null && sibL.keys.length > this._minkyl) {
            delKey = (this._item === 0) ? key : this._leaf.keys[0];
            this._leaf.keys.unshift(sibL.keys.pop());
            this._leaf.records.unshift(sibL.records.pop());
            BTree._fixNodes(stack, delKey, this._leaf.keys[0], modified);
            BTree._modifyNode(modified, sibL);
            return;
        }

        // Steal from right sibling if possible
        let sibR = (parPtr === parNod.keys.length) ? null : parNod.nodePointers[parPtr + 1];
        if (sibR !== null && sibR.keys.length > this._minkyl) {
            this._leaf.keys.push(sibR.keys.shift());
            this._leaf.records.push(sibR.records.shift());
            if (this._item === 0) BTree._fixNodes(stack, key, this._leaf.keys[0], modified);
            BTree._fixNodes(stack, this._leaf.keys[this._leaf.keys.length-1], sibR.keys[0], modified);
            BTree._modifyNode(modified, sibR);
            return;
        }

        // Merge left to make one leaf
        if (sibL !== null) {
            delKey = (this._item === 0) ? key : this._leaf.keys[0];
            sibL.merge(this._leaf, parNod, delKey);
            BTree._modifyNode(modified, sibL);
            BTree._modifyNode(removed, this._leaf);
            this._leaf = sibL;
        } else {
            delKey = sibR.keys[0];
            this._leaf.merge(sibR, parNod, delKey);
            BTree._modifyNode(modified, this._leaf);
            BTree._modifyNode(removed, sibR);
            if (this._item === 0) BTree._fixNodes(stack, key, this._leaf.keys[0], modified);
        }

        if (stack.length === 1 && parNod.keys.length === 0) {
            this._root = this._leaf;
            return;
        }

        let curNod = stack.pop();
        let parItm;

        // Update all nodes
        while (curNod.keys.length < this._minkyn && stack.length > 0) {

            parNod = stack.pop();
            parItm = parNod.getItem(delKey);

            // Steal from right sibling if possible
            sibR = (parItm === parNod.keys.length) ? null : parNod.nodePointers[parItm+1];
            if (sibR !== null && sibR.keys.length > this._minkyn) {
                curNod.keys.push(parNod.keys[parItm]);
                parNod.keys[parItm] = sibR.keys.shift();
                curNod.nodePointers.push(sibR.nodePointers.shift());
                BTree._modifyNode(modified, curNod);
                BTree._modifyNode(modified, sibR);
                BTree._modifyNode(modified, parNod);
                break;
            }

            // Steal from left sibling if possible
            sibL = (parItm === 0) ? null : parNod.nodePointers[parItm-1];
            if (sibL !== null && sibL.keys.length > this._minkyn) {
                curNod.keys.unshift(parNod.keys[parItm-1]);
                parNod.keys[parItm-1] = sibL.keys.pop();
                curNod.nodePointers.unshift(sibL.nodePointers.pop());
                BTree._modifyNode(modified, curNod);
                BTree._modifyNode(modified, sibL);
                BTree._modifyNode(modified, parNod);
                break;
            }

            // Merge left to make one node
            if (sibL !== null) {
                delKey = sibL.merge(curNod, parNod, parItm-1);
                BTree._modifyNode(removed, curNod);
                BTree._modifyNode(modified, sibL);
                curNod = sibL;
            } else if (sibR !== null) {
                delKey = curNod.merge(sibR, parNod, parItm);
                BTree._modifyNode(removed, sibR);
                BTree._modifyNode(modified, curNod);
            }

            // Next level
            if (stack.length === 0 && parNod.keys.length === 0) {
                this._root = curNod;
                break;
            }
            curNod = parNod;
        }
    }

    /**
     * Internal helper method to replace a key within the whole stack.
     * @param {Array.<Node>} stk The stack of nodes to examine.
     * @param {*} frKey The key to replace.
     * @param {*} toKey The new key to put in place.
     * @param {*} [modified] The optional set of modified nodes (will be updated by the method).
     * @private
     */
    static _fixNodes(stk, frKey, toKey, modified) {
        let keys, lvl = stk.length, mor = true;
        do {
            lvl--;
            keys = stk[lvl].keys;
            for (let i=keys.length-1; i>=0; --i) {
                if (keys[i] === frKey) {
                    keys[i] = toKey;
                    BTree._modifyNode(modified, stk[lvl]);
                    mor = false;
                    break;
                }
            }
        } while (mor && lvl>0);
    }

    /**
     * Advances to the smallest key k', such that either k' > lower (if lowerOpen) or k' ≥ lower (if !lowerOpen).
     * If lower is undefined, jump to the smallest key's entry.
     * @param {*} lower A lower bound on the key or undefined.
     * @param {boolean} [lowerOpen] Whether lower may be included or not.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goToLowerBound(lower, lowerOpen=false) {
        // TODO: it might be that there is no exact key match, then we do not need to skip!
        if (lower !== undefined) {
            let success = this.seek(lower, BTree.NEAR_MODE.GE);
            if (success && lowerOpen) {
                success = this.skip();
            }
            return success;
        }
        return this.goTop();
    }

    /**
     * Advances to the largest key k', such that either k' < upper (if upperOpen) or k' ≤ upper (if !upperOpen).
     * If upper is undefined, jump to the largest key's entry.
     * @param {*} upper An upper bound on the key or undefined.
     * @param {boolean} [upperOpen] Whether upper may be included or not.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goToUpperBound(upper, upperOpen=false) {
        // TODO: it might be that there is no exact key match, then we do not need to skip!
        if (upper !== undefined) {
            let success = this.seek(upper, BTree.NEAR_MODE.LE);
            if (success && upperOpen) {
                success = this.skip(-1);
            }
            return success;
        }
        return this.goBottom();
    }

    /**
     * An internal helper method used to add a node to a set.
     * If the given s is not a set, it does not do anything.
     * @param {Set|*} s The set to add the node to.
     * @param {Node} node The node to add to the set.
     * @private
     */
    static _modifyNode(s, node) {
        if (s instanceof Set && node !== undefined) {
            s.add(node);
        }
    }

    /**
     * Load a BTree from JSON objects.
     * This method can be used to load a BTree from a JSON database.
     * @param {number} rootId The id of the root node.
     * @param {Map.<number,Object>} nodes A map mapping node ids to JSON objects.
     * @param {number} [order] The order of the tree the nodes will be added to.
     * This is required to be the same as when storing the tree.
     */
    static loadFromJSON(rootId, nodes, order) {
        const tree = new BTree(order);
        const root = nodes.get(rootId);
        tree._root = root;
        const queue = [root];
        let maxId = 0;
        // Restore all nodes and pointers
        while (queue.length > 0) {
            const node = queue.shift();
            maxId = Math.max(node.id, maxId);

            if (node.isLeaf()) {
                let tmp = nodes.get(prevLeaf);
                node.prevLeaf = tmp ? tmp : null;
                if (node.prevLeaf) {
                    queue.push(node.prevLeaf);
                }
                tmp = nodes.get(nextLeaf);
                node.nextLeaf = tmp ? tmp : null;
                if (node.nextLeaf) {
                    queue.push(node.nextLeaf);
                }
            } else {
                for (let i=0; i<node.nodePointers.length; ++i) {
                    let tmp = nodes.get(node.nodePointers[i]);
                    tmp = tmp ? tmp : null;
                    if (tmp) {
                        queue.push(tmp);
                    }
                    node.nodePointers[i] = tmp;
                }
            }
        }
        tree._nodeId = maxId + 1; // Needed for persistence
    }

    /**
     * Dumps the current state of the tree into a map mapping node ids to JSON objects.
     * This method can be used to store the state of the tree into a JSON key value store.
     * @param {Map.<number,Object>} nodes This should be a reference to an empty map.
     * @returns {number} root The id of the root node.
     */
    dump(nodes) {
        nodes.clear();
        const queue = [this._root];
        // Save all nodes and pointers
        while (queue.length > 0) {
            const node = queue.shift();

            nodes.set(node.id, node.toJSON());

            if (node.isLeaf()) {
                if (node.prevLeaf) {
                    queue.push(node.prevLeaf);
                }
                if (node.nextLeaf) {
                    queue.push(node.nextLeaf);
                }
            } else {
                for (let i=0; i<node.nodePointers.length; ++i) {
                    if (node.nodePointers[i]) {
                        queue.push(node.nodePointers[i]);
                    }
                }
            }
        }
        return this._root.id;
    }
}
/**
 * Allows to specify the seek method of a BTree.
 * @enum {number}
 */
BTree.NEAR_MODE = {
    NONE: 0,
    LE: 1,
    GE: 2
};
Class.register(BTree);

/**
 * A TreeTransaction keeps track of the set of modified and removed nodes
 * during one or multiple operations on an underlying BTree.
 * @implements {IBTree}
 */
class TreeTransaction {
    /**
     * Create a TreeTransaction from a BTree.
     * @param {BTree} tree The underlying BTree.
     */
    constructor(tree) {
        this._tree = tree;

        // We potentially need to keep track of modifications to persist them.
        // To ensure consistency, the caller needs to collect modifications over multiple calls synchronously.
        // Hence, the observer pattern is not applicable here, and we keep modifications in the state if requested.
        this._modified = new Set();
        this._removed = new Set();
    }

    /**
     * This method allows to merge the set of modified and removed nodes
     * from two TreeTransactions.
     * @param {TreeTransaction} treeTx The other TreeTransaction to be merged.
     * @returns {TreeTransaction}
     */
    merge(treeTx) {
        if (!(treeTx instanceof TreeTransaction)) {
            return this;
        }
        this._removed = this._removed.union(treeTx.removed);
        this._modified = this._modified.union(treeTx.modified).difference(this._removed);
        return this;
    }

    /**
     * The set of modified nodes during the transaction.
     * @type {Set.<Node>}
     */
    get modified() {
        return this._modified;
    }

    /**
     * The set of removed nodes during the transaction.
     * @type {Set.<Node>}
     */
    get removed() {
        return this._removed;
    }

    /**
     * The root node of the underlying tree.
     * @type {Node}
     */
    get root() {
        return this._tree._root;
    }

    /**
     * The total number of records.
     * Note that if the record is a list/set of records, these are not counted.
     * @type {number}
     */
    get length() {
        return this._tree.length;
    }

    /**
     * The current key as returned by any operation.
     * It is null if there is no matching record.
     * @type {*}
     */
    get currentKey() {
        return this._tree.currentKey;
    }

    /**
     * The current record as returned by any operation.
     * It is null if there is no matching record.
     * This getter also adds the node to the set of modified nodes
     * as we cannot keep track whether something will be modified.
     * @type {*}
     */
    get currentRecord() {
        // Potentially untracked modification.
        if (this._tree.currentLeaf !== undefined) {
            this._modified.add(this._tree.currentLeaf);
        }
        return this._tree.currentRecord;
    }

    /**
     * Inserts a new key-record pair into the BTree, if there is no entry for that key.
     * The current record and current key are set to the new entry in case of success
     * or the existing entry if present.
     * @param {*} key The unique key for the record.
     * @param {*} rec The record associated with the key.
     * @returns {boolean} True if the record was inserted, false if there was already a record with that key.
     */
    insert(key, rec) {
        return this._tree.insert(key, rec, this._modified);
    }

    /**
     * Removes a key-record pair from the BTree.
     * In case of successful deletion, the current record and key will be set to the next entry greater or equal.
     * If no record was found, they will be reset to null.
     * @param {*} key The unique key for the record.
     * @returns {boolean} True if the record was deleted, false if there is no such record.
     */
    remove(key) {
        return this._tree.remove(key, this._modified, this._removed);
    }

    /**
     * Searches the tree for a specific key and advances the current key/record pointers if found.
     * By default only an exact key match is found, but the near parameter also allows to advance to the next entry
     * greater/less or equal than the specified key.
     * @param {*} key The key to look for.
     * @param {BTree.NEAR_MODE} [near] Optional parameter, specifies to look for a key k' =/≤/≥ key.
     * @returns {boolean} True if such a key was found, false otherwise.
     */
    seek(key, near=BTree.NEAR_MODE.NONE) {
        return this._tree.seek(key, near);
    }

    /**
     * Advances the current key/record pointers by a given number of steps.
     * Default is advancing by 1, which means the next record (the new key will thus be the next larger key).
     * -1 means the previous record (the new key will thus be the next smaller key).
     * @param {number} [cnt] The number of records to advance (may be negative).
     * @returns {boolean} True if there is a record to advance to, false otherwise.
     */
    skip(cnt = 1) {
        return this._tree.skip(cnt);
    }

    /**
     * Jumps to the cnt entry starting from the smallest key (i.e., leftmost leaf, first entry) if cnt > 0.
     * If cnt < 0, it jumps to the cnt entry starting from the largest key (i.e., rightmost leaf, last entry).
     * @param {number} [cnt] The record to jump to (may be negative).
     * @returns {boolean} True if there is a record to jump to, false otherwise.
     */
    goto(cnt) {
        return this._tree.goto(cnt);
    }

    /**
     * Returns the index of the current entry (key/record) in a sorted list of all entries.
     * For the B+ Tree, this is done by traversing the leafs from the leftmost leaf, first entry
     * until the respective key is found.
     * @returns {number} The entry position.
     */
    keynum() {
        return this._tree.keynum();
    }

    /**
     * Jumps to the smallest key's entry (i.e., leftmost leaf, first entry).
     * False will only be returned if the tree is completely empty.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goTop() {
        return this._tree.goTop();
    }

    /**
     * Jumps to the largest key's entry (i.e., rightmost leaf, last entry).
     * False will only be returned if the tree is completely empty.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goBottom() {
        return this._tree.goBottom();
    }

    /**
     * Rebuilds/balances the whole tree.
     * Inserting and deleting keys into a tree will result
     * in some leaves and nodes having the minimum number of keys allowed.
     * This routine will ensure that each leaf and node has as many keys as possible,
     * resulting in a denser, flatter tree.
     * False is only returned if the tree is completely empty.
     * @returns {boolean} True if the tree is not completely empty.
     */
    pack() {
        return this._tree.pack();
    }

    /**
     * Advances to the smallest key k', such that either k' > lower (if lowerOpen) or k' ≥ lower (if !lowerOpen).
     * If lower is undefined, jump to the smallest key's entry.
     * @param {*} lower A lower bound on the key or undefined.
     * @param {boolean} [lowerOpen] Whether lower may be included or not.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goToLowerBound(lower, lowerOpen=false) {
        return this._tree.goToLowerBound(lower, lowerOpen);
    }

    /**
     * Advances to the largest key k', such that either k' < upper (if upperOpen) or k' ≤ upper (if !upperOpen).
     * If upper is undefined, jump to the largest key's entry.
     * @param {*} upper An upper bound on the key or undefined.
     * @param {boolean} [upperOpen] Whether upper may be included or not.
     * @returns {boolean} True if there is such an entry, false otherwise.
     */
    goToUpperBound(upper, upperOpen=false) {
        return this._tree.goToUpperBound(upper, upperOpen);
    }
}
Class.register(TreeTransaction);

class Log {
    /**
     * @returns {Log}
     */
    static get instance() {
        if (!Log._instance) {
            Log._instance = new Log(new LogNative());
        }
        return Log._instance;
    }

    /**
     * @param {LogNative} native
     */
    constructor(native) {
        /** @type {LogNative} */
        this._native = native;
    }

    /**
     * @param {string} tag
     * @param {Log.Level} level
     */
    setLoggable(tag, level) {
        this._native.setLoggable(tag, level);
    }

    /** @type {Log.Level} */
    get level() {
        return this._native._global_level;
    }

    /** @type {Log.Level} */
    set level(l) {
        this._native._global_level = l;
    }

    /**
     * @param {Log.Level} level
     * @param {string|{name:string}} tag
     * @param {Array} args
     */
    msg(level, tag, args) {
        this._native.msg(level, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static d(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.DEBUG, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static e(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.ERROR, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static i(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.INFO, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static v(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.VERBOSE, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static w(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.WARNING, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string} message
     * @param {...*} args
     */
    static t(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.TRACE, tag, args);
    }
}
/**
 * @enum {number}
 */
Log.Level = {
    TRACE: 1,
    VERBOSE: 2,
    DEBUG: 3,
    INFO: 4,
    WARNING: 5,
    ERROR: 6,
    ASSERT: 7,

    /**
     * @param {Log.Level} level
     */
    toStringTag: function (level) {
        switch (level) {
            case Log.TRACE:
                return 'T';
            case Log.VERBOSE:
                return 'V';
            case Log.DEBUG:
                return 'D';
            case Log.INFO:
                return 'I';
            case Log.WARNING:
                return 'W';
            case Log.ERROR:
                return 'E';
            case Log.ASSERT:
                return 'A';
            default:
                return '*';
        }
    }
};
Log.TRACE = Log.Level.TRACE;
Log.VERBOSE = Log.Level.VERBOSE;
Log.DEBUG = Log.Level.DEBUG;
Log.INFO = Log.Level.INFO;
Log.WARNING = Log.Level.WARNING;
Log.ERROR = Log.Level.ERROR;
Log.ASSERT = Log.Level.ASSERT;
Log._instance = null;
Class.register(Log);

/**
 * An implementation of a LRU (least recently used) map.
 * This is a map that contains a maximum of k entries,
 * where k is specified in the constructor.
 * When the maximal number of entries is reached,
 * it will evict the least recently used entry.
 * This behaviour is useful for caches.
 * @template K The keys' type.
 * @template V The values' type.
 */
class LRUMap {
    /**
     * Instantiate a LRU map of maximum size maxSize.
     * @param {number} maxSize The maximum size of the map.
     */
    constructor(maxSize) {
        this._maxSize = maxSize;
        /** @type {Map.<K,V>} */
        this._map = new Map();
        /** @type {Map.<K,number>} */
        this._numAccesses = new Map();
        /** @type {Array.<K>} */
        this._accessQueue = [];
    }

    /**
     * The current size of the map.
     * @type {number}
     */
    get size() {
        return this._map.size;
    }

    /**
     * Clears the map.
     */
    clear() {
        this._numAccesses.clear();
        this._accessQueue = [];
        return this._map.clear();
    }

    /**
     * Deletes a key from the map.
     * @param {K} key The key to delete.
     * @returns {boolean} Whether an entry was deleted.
     */
    delete(key) {
        return this._map.delete(key);
    }

    /**
     * Returns an iterator over key value pairs [k, v].
     * @returns {Iterator.<Array>}
     */
    entries() {
        return this._map.entries();
    }

    /**
     * Execute a given function for each key value pair in the map.
     * @param {function(key:K, value:V):*} callback The function to be called.
     * @param {*} [thisArg] This value will be used as this when executing the function.
     */
    forEach(callback, thisArg) {
        return this._map.forEach(callback, thisArg);
    }

    /**
     * Return the corresponding value to a specified key.
     * @param {K} key The key to look for.
     * @returns {V} The value the key maps to (or undefined if not present).
     */
    get(key) {
        this.access(key);
        return this._map.get(key);
    }

    /**
     * Returns true if the specified key is to be found in the map.
     * @param {K} key The key to look for.
     * @returns {boolean} True, if the key is in the map, false otherwise.
     */
    has(key) {
        return this._map.has(key);
    }

    /**
     * Returns an iterator over the keys of the map.
     * @returns {Iterator.<K>}
     */
    keys() {
        return this._map.keys();
    }

    /**
     * Evicts the k least recently used entries from the map.
     * @param {number} [k] The number of entries to evict (default is 1).
     */
    evict(k=1) {
        while (k > 0 && this._accessQueue.length > 0) {
            const oldest = this._accessQueue.shift();
            let accesses = this._numAccesses.get(oldest);
            --accesses;
            this._numAccesses.set(oldest, accesses);
            // Check if not used in the meanwhile.
            if (accesses !== 0) {
                continue;
            }
            // Otherwise delete that.
            this._numAccesses.delete(oldest);
            // If it was not present however, we need to search further.
            if (!this.delete(oldest)) {
                continue;
            }
            --k;
        }
    }

    /**
     * Marks a key as accessed.
     * This implicitly makes the key the most recently used key.
     * @param {K} key The key to mark as accessed.
     */
    access(key) {
        if (!this._map.has(key)) {
            return;
        }
        let accesses = 0;
        if (this._numAccesses.has(key)) {
            accesses = this._numAccesses.get(key);
        }
        ++accesses;
        this._numAccesses.set(key, accesses);
        this._accessQueue.push(key);
    }

    /**
     * Inserts or replaces a key's value into the map.
     * If the maxSize of the map is exceeded, the least recently used key is evicted first.
     * Inserting a key implicitly accesses it.
     * @param {K} key The key to set.
     * @param {V} value The associated value.
     */
    set(key, value) {
        if (this.size >= this._maxSize) {
            this.evict();
        }
        this._map.set(key, value);
        this.access(key);
    }

    /**
     * Returns an iterator over the values of the map.
     * @returns {Iterator.<V>}
     */
    values() {
        return this._map.values();
    }

    /**
     * Returns an iterator over key value pairs [k, v].
     * @returns {Iterator.<Array>}
     */
    [Symbol.iterator]() {
        return this._map.entries();
    }
}
Class.register(LRUMap);

/**
 * Utils that are related to common JavaScript objects.
 */
class ObjectUtils {
    /**
     * This method returns the value of an object at a given path.
     * A key path is defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * @param {Object} obj The JS object to access.
     * @param {string|Array.<string>} path The key path to access.
     * @returns {*} The value at the given path or undefined if the path does not exist..
     */
    static byKeyPath(obj, path) {
        if (!Array.isArray(path)) {
            return obj[path];
        }
        let tmp = obj;
        for (const component of path) {
            if (tmp === undefined) {
                return undefined;
            }
            tmp = tmp[component];
        }
        return tmp;
    }
}
Class.register(ObjectUtils);

/**
 * A class, which inherits from Observable, can notify interested parties
 * on occurrence of specified events.
 */
class Observable {
    /**
     * A special event matching every other event.
     * @type {string}
     * @constant
     */
    static get WILDCARD() {
        return '*';
    }

    constructor() {
        /** @type {Map.<string, Array.<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Registers a handler for a given event.
     * @param {string} type The event to observe.
     * @param {Function} callback The handler to be called on occurrence of the event.
     * @return {number} The handle for this handler. Can be used to unregister it again.
     */
    on(type, callback) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, [callback]);
            return 0;
        } else {
            return this._listeners.get(type).push(callback) - 1;
        }
    }

    /**
     * Unregisters a handler for a given event.
     * @param {string} type The event to unregister from.
     * @param {number} id The handle received upon calling the on function.
     */
    off(type, id) {
        if (!this._listeners.has(type) || !this._listeners.get(type)[id]) return;
        delete this._listeners.get(type)[id];
    }

    /**
     * Fires an event and notifies all observers.
     * @param {string} type The type of event.
     * @param {...*} args Arguments to pass to the observers.
     */
    fire(type, ...args) {
        // Notify listeners for this event type.
        if (this._listeners.has(type)) {
            for (const i in this._listeners.get(type)) {
                const listener = this._listeners.get(type)[i];
                listener.apply(null, args);
            }
        }

        // Notify wildcard listeners. Pass event type as first argument
        if (this._listeners.has(Observable.WILDCARD)) {
            for (const i in this._listeners.get(Observable.WILDCARD)) {
                const listener = this._listeners.get(Observable.WILDCARD)[i];
                listener.apply(null, arguments);
            }
        }
    }

    /**
     * Registers handlers on another observable, bubbling its events up to the own observers.
     * @param {Observable} observable The observable, whose events should bubble up.
     * @param {...string} types The events to bubble up.
     */
    bubble(observable, ...types) {
        for (const type of types) {
            let callback;
            if (type == Observable.WILDCARD) {
                callback = function() {
                    this.fire.apply(this, arguments);
                };
            } else {
                callback = function() {
                    this.fire.apply(this, [type, ...arguments]);
                };
            }
            observable.on(type, callback.bind(this));
        }
    }
}
Class.register(Observable);

/**
 * Calculates the union of two sets.
 * Method of Set.
 * @memberOf Set
 * @param {Set} setB The second set.
 * @returns {Set} The union of this set and the second set.
 */
Set.prototype.union = function(setB) {
    const union = new Set(this);
    for (const elem of setB) {
        union.add(elem);
    }
    return union;
};

/**
 * Calculates the intersection of two sets.
 * Method of Set.
 * @memberOf Set
 * @param {Set} setB The second set.
 * @returns {Set} The intersection of this set and the second set.
 */
Set.prototype.intersection = function(setB) {
    const intersection = new Set();
    for (const elem of setB) {
        if (this.has(elem)) {
            intersection.add(elem);
        }
    }
    return intersection;
};

/**
 * Calculates the difference of two sets.
 * Method of Set.
 * @memberOf Set
 * @param {Set} setB The second set.
 * @returns {Set} The difference of this set and the second set.
 */
Set.prototype.difference = function(setB) {
    const difference = new Set(this);
    for (const elem of setB) {
        difference.delete(elem);
    }
    return difference;
};

/**
 * Checks whether two sets are equal to each other.
 * Method of Set.
 * @memberOf Set
 * @param {Set} setB The second set.
 * @returns {boolean} True if they contain the same elements, false otherwise.
 */
Set.prototype.equals = function(setB) {
    if (this.size !== setB.size) return false;
    for (const elem of setB) {
        if (!this.has(elem)) {
            return false;
        }
    }
    return true;
};

/**
 * Creates a Set from single values and iterables.
 * If arg is not iterable, it creates a new Set with arg as its single member.
 * If arg is iterable, it iterates over arg and puts all items into the Set.
 * Static method of Set.
 * @memberOf Set
 * @param {*} arg The argument to create the Set from.
 * @returns {Set} The resulting Set.
 */
Set.from = function(arg) {
    // Check if iterable and not string.
    if (arg && typeof arg[Symbol.iterator] === 'function' && typeof arg !== 'string') {
        return new Set(arg);
    }
    return new Set([arg]);
};

/**
 * Returns an element of a Set.
 * Static method of Set.
 * @memberOf Set
 * @template T
 * @param {Set.<T>} s The set to return an element from.
 * @returns {T} An element of the set.
 */
Set.sampleElement = function(s) {
    return s.size > 0 ? s.values().next().value : undefined;
};

class Synchronizer extends Observable {
    constructor() {
        super();
        this._queue = [];
        this._working = false;
    }

    /**
     * Push function to the Synchronizer for later, synchronous execution
     * @template T
     * @param {function():T} fn Function to be invoked later by this Synchronizer
     * @returns {Promise.<T>}
     */
    push(fn) {
        return new Promise((resolve, error) => {
            this._queue.push({fn: fn, resolve: resolve, error: error});
            if (!this._working) {
                this._doWork();
            }
        });
    }

    async _doWork() {
        this._working = true;
        this.fire('work-start', this);

        while (this._queue.length) {
            const job = this._queue.shift();
            try {
                const result = await job.fn();
                job.resolve(result);
            } catch (e) {
                if (job.error) job.error(e);
            }
        }

        this._working = false;
        this.fire('work-end', this);
    }

    /** @type {boolean} */
    get working() {
        return this._working;
    }
}
Class.register(Synchronizer);

/**
 * This is an intermediate layer caching the results of a backend.
 * While simple get/put queries make use of the cache,
 * more advanced queries will be forwarded to the backend.
 * @implements {IBackend}
 */
class CachedBackend {
    /**
     * Creates a new instance of the cached layer using the specified backend.
     * @param {IBackend} backend The backend to use.
     */
    constructor(backend) {
        this._backend = backend;
        /** @type {Map.<string,*>} */
        this._cache = new LRUMap(CachedBackend.MAX_CACHE_SIZE);
    }

    /** @type {boolean} */
    get connected() {
        return this._backend.connected;
    }

    /**
     * A map of index names to indices as defined by the underlying backend.
     * The index names can be used to access an index.
     * @type {Map.<string,IIndex>}
     */
    get indices() {
        return this._backend.indices;
    }

    /**
     * A helper method to retrieve the values corresponding to a set of keys.
     * @param {Set.<string>} keys The set of keys to get the corresponding values for.
     * @returns {Promise.<Array.<*>>} A promise of the array of values.
     * @protected
     */
    async _retrieveValues(keys) {
        const valuePromises = [];
        for (const key of keys) {
            valuePromises.push(this.get(key));
        }
        return Promise.all(valuePromises);
    }

    /**
     * Returns a promise of the object stored under the given primary key.
     * If the item is in the cache, the cached value will be returned.
     * Otherwise, the value will be fetched from the backend object store..
     * Resolves to undefined if the key is not present in the object store.
     * @param {string} key The primary key to look for.
     * @returns {Promise.<*>} A promise of the object stored under the given key, or undefined if not present.
     */
    async get(key) {
        if (this._cache.has(key)) {
            return this._cache.get(key);
        }
        const value = await this._backend.get(key);
        this._cache.set(key, value);
        return value;
    }

    /**
     * Inserts or replaces a key-value pair.
     * Stores the new key-value pair in both the cache and the backend.
     * @param {string} key The primary key to associate the value with.
     * @param {*} value The value to write.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    put(key, value) {
        this._cache.set(key, value);
        return this._backend.put(key, value);
    }

    /**
     * Removes the key-value pair of the given key from the cache and the backend.
     * @param {string} key The primary key to delete along with the associated object.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    remove(key) {
        this._cache.delete(key);
        return this._backend.remove(key);
    }

    /**
     * Returns a promise of a set of keys fulfilling the given query by querying the backend.
     * If the optional query is not given, it returns all keys in the object store.
     * If the query is of type KeyRange, it returns all keys of the object store being within this range.
     * If the query is of type Query, it returns all keys fulfilling the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to the query.
     */
    keys(query=null) {
        return this._backend.keys(query);
    }

    /**
     * Returns a promise of an array of objects whose primary keys fulfill the given query by relying on the backend.
     * If the optional query is not given, it returns all objects in the object store.
     * If the query is of type KeyRange, it returns all objects whose primary keys are within this range.
     * If the query is of type Query, it returns all objects whose primary keys fulfill the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    values(query=null) {
        return this._backend.values(query);
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     */
    keyStream(callback, ascending=true, query=null) {
        return this._backend.keyStream(callback, ascending, query);
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     */
    valueStream(callback, ascending=true, query=null) {
        return this._backend.valueStream(callback, ascending, query);
    }

    /**
     * Returns a promise of the object whose primary key is maximal for the given range.
     * If the optional query is not given, it returns the object whose key is maximal.
     * If the query is of type KeyRange, it returns the object whose primary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    maxValue(query=null) {
        return this._backend.maxValue(query);
    }

    /**
     * Returns a promise of the key being maximal for the given range.
     * If the optional query is not given, it returns the maximal key.
     * If the query is of type KeyRange, it returns the key being maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    maxKey(query=null) {
        return this._backend.maxKey(query);
    }

    /**
     * Returns a promise of the key being minimal for the given range.
     * If the optional query is not given, it returns the minimal key.
     * If the query is of type KeyRange, it returns the key being minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    minKey(query=null) {
        return this._backend.minKey(query);
    }

    /**
     * Returns a promise of the object whose primary key is minimal for the given range.
     * If the optional query is not given, it returns the object whose key is minimal.
     * If the query is of type KeyRange, it returns the object whose primary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    minValue(query=null) {
        return this._backend.minValue(query);
    }

    /**
     * Returns the count of entries in the given range.
     * If the optional query is not given, it returns the count of entries in the object store.
     * If the query is of type KeyRange, it returns the count of entries within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    count(query=null) {
        return this._backend.count(query);
    }

    /**
     * Unsupported operation for a cached backend.
     * @param {Transaction} [tx]
     * @returns {Promise.<boolean>}
     */
    async commit(tx) {
        throw new Error('Unsupported operation');
    }

    /**
     * Unsupported operation for a cached backend.
     * @param {Transaction} [tx]
     */
    async abort(tx) {
        throw new Error('Unsupported operation');
    }

    /**
     * Internally applies a transaction to the cache's and backend's state.
     * This needs to be done in batch (as a db level transaction), i.e., either the full state is updated
     * or no changes are applied.
     * @param {Transaction} tx The transaction to apply.
     * @returns {Promise} The promise resolves after applying the transaction.
     * @protected
     */
    _apply(tx) {
        this._applyLocally(tx);
        return this._backend._apply(tx);
    }

    /**
     * Internally applies a transaction to the cache's state.
     * @param {Transaction} tx The transaction to apply.
     * @returns {Promise} The promise resolves after applying the transaction.
     * @protected
     */
    _applyLocally(tx) {
        // Update local state and push to backend for batch transaction.
        if (tx._truncated) {
            this._cache.clear();
        }
        for (const key of tx._removed) {
            this._cache.delete(key);
        }
        for (const [key, value] of tx._modified) {
            this._cache.set(key, value);
        }
    }

    /**
     * Empties the object store.
     * @returns {Promise} The promise resolves after emptying the object store.
     */
    async truncate() {
        this._cache.clear();
        return this._backend.truncate();
    }

    /**
     * Returns the index of the given name.
     * If the index does not exist, it returns undefined.
     * @param {string} indexName The name of the requested index.
     * @returns {IIndex} The index associated with the given name.
     */
    index(indexName) {
        return this._backend.index(indexName);
    }

    /**
     * Creates a new secondary index on the object store.
     * Currently, all secondary indices are non-unique.
     * They are defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * Secondary indices may be multiEntry, i.e., if the keyPath resolves to an iterable object, each item within can
     * be used to find this entry.
     * If a new object does not possess the key path associated with that index, it is simply ignored.
     *
     * This function may only be called before the database is connected.
     * Moreover, it is only executed on database version updates or on first creation.
     * @param {string} indexName The name of the index.
     * @param {string|Array.<string>} [keyPath] The path to the key within the object. May be an array for multiple levels.
     * @param {boolean} [multiEntry]
     */
    createIndex(indexName, keyPath, multiEntry=false) {
        return this._backend.createIndex(indexName, keyPath, multiEntry);
    }

    /**
     * Deletes a secondary index from the object store.
     * @param indexName
     * @returns {Promise} The promise resolves after deleting the index.
     */
    deleteIndex(indexName) {
        return this._backend.deleteIndex(indexName);
    }

    /**
     * Closes the object store and potential connections.
     * @returns {Promise} The promise resolves after closing the object store.
     */
    close() {
        return this._backend.close();
    }

    /**
     * Creates a new transaction, ensuring read isolation
     * on the most recently successfully committed state.
     * @returns {Transaction} The transaction object.
     */
    transaction() {
        throw new Error('Unsupported operation');
    }

    /**
     * Returns the necessary information in order to flush a combined transaction.
     * @abstract
     * @param {Transaction} tx The transaction that should be applied to this backend.
     * @returns {Promise.<*|function()|Array.<*|function()>>} For non-persistent backends: a function that effectively applies the transaction.
     * Native backends otherwise specify their own information as needed by their JungleDB instance.
     */
    async applyCombined(tx) {
        return [await this._backend.applyCombined(tx), () => this._applyLocally(tx)];
    }
}
/** @type {number} Maximum number of cached elements. */
CachedBackend.MAX_CACHE_SIZE = 5000 /*elements*/;
Class.register(CachedBackend);

/**
 * This is a BTree based index, which is generally stored in memory.
 * It is used by transactions.
 * @implements {IIndex}
 */
class InMemoryIndex {
    /**
     * Creates a new InMemoryIndex for a given object store.
     * The key path describes the path of the secondary key within the stored objects.
     * Only objects for which the key path exists are part of the secondary index.
     *
     * A key path is defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     *
     * If a secondary index is a multi entry index, and the value at the key path is iterable,
     * every item of the iterable value will be associated with the object.
     * @param {IObjectStore} objectStore The underlying object store to use.
     * @param {string|Array.<string>} [keyPath] The key path of the indexed attribute.
     * If the keyPath is not given, this is a primary index.
     * @param {boolean} [multiEntry] Whether the indexed attribute is considered to be iterable or not.
     * @param {boolean} [unique] Whether there is a unique constraint on the attribute.
     */
    constructor(objectStore, keyPath, multiEntry=false, unique=false) {
        this._objectStore = objectStore;
        this._keyPath = keyPath;
        this._multiEntry = multiEntry;
        this._unique = unique;
        this._tree = new BTree();
    }

    /**
     * Reinitialises the index.
     * @returns {Promise} The promise resolves after emptying the index.
     */
    async truncate() {
        this._tree = new BTree();
    }

    /**
     * Helper method to return the attribute associated with the key path if it exists.
     * @param {string} key The primary key of the key-value pair.
     * @param {*} obj The value of the key-value pair.
     * @returns {*} The attribute associated with the key path, if it exists, and undefined otherwise.
     * @private
     */
    _indexKey(key, obj) {
        if (this.keyPath) {
            if (obj === undefined) return undefined;
            return ObjectUtils.byKeyPath(obj, this.keyPath);
        }
        return key;
    }

    /**
     * The key path associated with this index.
     * A key path is defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * If the keyPath is undefined, this index uses the primary key of the key-value store.
     * @type {string|Array.<string>}
     */
    get keyPath() {
        return this._keyPath;
    }

    /**
     * This value determines whether the index supports multiple secondary keys per entry.
     * If so, the value at the key path is considered to be an iterable.
     * @type {boolean}
     */
    get multiEntry() {
        return this._multiEntry;
    }

    /**
     * A helper method to insert a primary-secondary key pair into the tree.
     * @param {string} key The primary key.
     * @param {*} iKey The indexed key.
     * @param {IBTree} [tree] The optional tree in which to insert the pair.
     * @throws if the uniqueness constraint is violated.
     */
    _insert(key, iKey, tree) {
        tree = tree || this._tree;
        if (!this._multiEntry || !Array.isArray(iKey)) {
            iKey = [iKey];
        }
        // Add all keys.
        for (const component of iKey) {
            if (tree.seek(component)) {
                if (this._unique) {
                    throw new Error(`Uniqueness constraint violated for key ${key} on path ${this._keyPath}`);
                }
                tree.currentRecord.add(key);
            } else {
                tree.insert(component, this._unique ? key : Set.from(key));
            }
        }
    }

    /**
     * Inserts a new key-value pair into the index.
     * For replacing an existing pair, the old value has to be passed as well.
     * @param {string} key The primary key of the pair.
     * @param {*} value The value of the pair. The indexed key will be extracted from this.
     * @param {*} [oldValue] The old value associated with the primary key.
     * @returns {TreeTransaction} The TreeTransaction that was needed to insert/replace the key-value pair.
     */
    put(key, value, oldValue) {
        const treeTx = this._tree.transaction();
        const oldIKey = this._indexKey(key, oldValue);
        const newIKey = this._indexKey(key, value);

        if (oldIKey !== undefined) {
            this._remove(key, oldIKey, treeTx);
        }
        if (newIKey !== undefined) {
            this._insert(key, newIKey, treeTx);
        }
        return treeTx;
    }

    /**
     * Removes a key-value pair from the index.
     * @param {string} key The primary key of the pair.
     * @param {*} oldValue The old value of the pair. The indexed key will be extracted from this.
     * @returns {TreeTransaction} The TreeTransaction that was needed to remove the key-value pair.
     */
    remove(key, oldValue) {
        const treeTx = this._tree.transaction();
        if (oldValue !== undefined) {
            const iKey = this._indexKey(key, oldValue);
            this._remove(key, iKey, treeTx);
        }
        return treeTx;
    }

    /**
     * A helper method to remove a primary-secondary key pair from the tree.
     * @param {string} key The primary key.
     * @param {*} iKey The indexed key.
     * @param {IBTree} [tree] The optional tree in which to insert the pair.
     */
    _remove(key, iKey, tree) {
        tree = tree || this._tree;
        if (!this._multiEntry || !Array.isArray(iKey)) {
            iKey = [iKey];
        }
        // Remove all keys.
        for (const component of iKey) {
            if (tree.seek(component)) {
                if (!this._unique && tree.currentRecord.size > 1) {
                    tree.currentRecord.delete(key);
                } else {
                    tree.remove(component);
                }
            }
        }
    }

    /**
     * A helper method to retrieve the values corresponding to a set of keys.
     * @param {Set.<string>} keys The set of keys to get the corresponding values for.
     * @returns {Promise.<Array.<*>>} A promise of the array of values.
     * @protected
     */
    async _retrieveValues(keys) {
        const valuePromises = [];
        for (const key of keys) {
            valuePromises.push(this._objectStore.get(key));
        }
        return Promise.all(valuePromises);
    }

    /**
     * Returns a promise of an array of objects whose secondary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the index.
     * If the query is of type KeyRange, it returns all objects whose secondary keys are within this range.
     * @param {KeyRange} [query] Optional query to check secondary keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    async values(query=null) {
        const keys = await this.keys(query);
        return this._retrieveValues(keys);
    }

    /**
     * Returns a promise of a set of primary keys, whose associated objects' secondary keys are in the given range.
     * If the optional query is not given, it returns all primary keys in the index.
     * If the query is of type KeyRange, it returns all primary keys for which the secondary key is within this range.
     * @param {KeyRange} [query] Optional query to check the secondary keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of primary keys relevant to the query.
     */
    async keys(query=null) {
        let resultSet = new Set();

        // Shortcut for exact match.
        if (query instanceof KeyRange && query.exactMatch) {
            if (this._tree.seek(query.lower)) {
                resultSet = Set.from(this._tree.currentRecord);
            }
            return resultSet;
        }

        // Find lower bound and start from there.
        if (!(query instanceof KeyRange)) {
            this._tree.goTop();
        } else {
            if (!this._tree.goToLowerBound(query.lower, query.lowerOpen)) {
                return resultSet; // empty
            }
        }

        while (!(query instanceof KeyRange) || query.includes(this._tree.currentKey)) {
            resultSet = resultSet.union(Set.from(this._tree.currentRecord));
            if (!this._tree.skip()) {
                break;
            }
        }
        return resultSet;
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    keyStream(callback, ascending=true, query=null) {
        if (!this._unique) {
            throw new Error('Unsupported operation for non-unique indices');
        }

        // Find lower bound and start from there.
        if (!(query instanceof KeyRange)) {
            if (ascending) {
                this._tree.goTop();
            } else {
                this._tree.goBottom();
            }
        } else {
            if (ascending) {
                if (!this._tree.goToLowerBound(query.lower, query.lowerOpen)) {
                    return Promise.resolve();
                }
            } else {
                if (!this._tree.goToUpperBound(query.upper, query.upperOpen)) {
                    return Promise.resolve();
                }
            }
        }

        while (!(query instanceof KeyRange) || query.includes(this._tree.currentKey)) {
            if (!callback(this._tree.currentRecord)) {
                break;
            }
            if (!this._tree.skip(ascending ? 1 : -1)) {
                break;
            }
        }
        return Promise.resolve();
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolved after all elements have been streamed.
     */
    async valueStream(callback, ascending=true, query=null) {
        if (!this._unique) {
            throw new Error('Unsupported operation for non-unique indices');
        }

        // Find lower bound and start from there.
        if (!(query instanceof KeyRange)) {
            if (ascending) {
                this._tree.goTop();
            } else {
                this._tree.goBottom();
            }
        } else {
            if (ascending) {
                if (!this._tree.goToLowerBound(query.lower, query.lowerOpen)) {
                    return;
                }
            } else {
                if (!this._tree.goToUpperBound(query.upper, query.upperOpen)) {
                    return;
                }
            }
        }

        while (!(query instanceof KeyRange) || query.includes(this._tree.currentKey)) {
            if (!callback(await this._objectStore.get(this._tree.currentRecord), this._tree.currentRecord)) {
                break;
            }
            if (!this._tree.skip(ascending ? 1 : -1)) {
                break;
            }
        }
    }

    /**
     * Returns a promise of an array of objects whose secondary key is maximal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async maxValues(query=null) {
        const keys = await this.maxKeys(query);
        return this._retrieveValues(keys);
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are maximal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async maxKeys(query=null) {
        const isRange = query instanceof KeyRange;
        if (!this._tree.goToUpperBound(isRange ? query.upper : undefined, isRange ? query.upperOpen : false)) {
            return new Set();
        }
        return Set.from(this._tree.currentRecord);
    }

    /**
     * Returns a promise of an array of objects whose secondary key is minimal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async minValues(query=null) {
        const keys = await this.minKeys(query);
        return this._retrieveValues(keys);
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are minimal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async minKeys(query=null) {
        const isRange = query instanceof KeyRange;
        if (!this._tree.goToLowerBound(isRange ? query.lower : undefined, isRange ? query.lowerOpen : false)) {
            return new Set();
        }
        return Set.from(this._tree.currentRecord);
    }

    /**
     * Returns the count of entries, whose secondary key is in the given range.
     * If the optional query is not given, it returns the count of entries in the index.
     * If the query is of type KeyRange, it returns the count of entries, whose secondary key is within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        return (await this.keys(query)).size;
        // The code below does only work for unique indices.
        // if (!(query instanceof KeyRange)) {
        //     return this._tree.length;
        // }
        // if (!this._tree.goToLowerBound(query.lower, query.lowerOpen)) {
        //     return 0;
        // }
        // const start = this._tree.keynum();
        // if (!this._tree.goToUpperBound(query.upper, query.upperOpen)) {
        //     return 0;
        // }
        // const end = this._tree.keynum();
        // return end - start + 1;
    }
}
Class.register(InMemoryIndex);


/**
 * Transactions are created by calling the transaction method on an ObjectStore object.
 * Transactions ensure read-isolation.
 * On a given state, only *one* transaction can be committed successfully.
 * Other transactions based on the same state will end up in a conflicted state if committed.
 * Transactions opened after the successful commit of another transaction will be based on the
 * new state and hence can be committed again.
 * @implements {IBackend}
 */
class InMemoryBackend {
    constructor(tableName, codec=null) {
        this._cache = new Map();

        /** @type {Map.<string,PersistentIndex>} */
        this._indices = new Map();

        this._primaryIndex = new InMemoryIndex(this, undefined, false, true);
        this._tableName = tableName;
        this._codec = codec;
    }

    /** @type {boolean} */
    get connected() {
        return true;
    }

    /**
     * @type {Map.<string,IIndex>}
     */
    get indices() {
        return this._indices;
    }

    /**
     * @param {string} key
     * @returns {Promise.<*>}
     */
    async get(key) {
        return this.decode(this._cache.get(key), key);
    }

    /**
     * @param {string} key
     * @param {*} value
     * @returns {Promise}
     */
    async put(key, value) {
        const oldValue = await this.get(key);
        this._cache.set(key, this.encode(value));
        const indexPromises = [
            this._primaryIndex.put(key, value, oldValue)
        ];
        for (const index of this._indices.values()) {
            indexPromises.push(index.put(key, value, oldValue));
        }
        return Promise.all(indexPromises);
    }

    /**
     * @param {string} key
     * @returns {Promise}
     */
    async remove(key) {
        const oldValue = await this.get(key);
        this._cache.delete(key);
        const indexPromises = [
            this._primaryIndex.remove(key, oldValue)
        ];
        for (const index of this._indices.values()) {
            indexPromises.push(index.remove(key, oldValue));
        }
        return Promise.all(indexPromises);
    }

    /**
     * @param {Query|KeyRange} [query]
     * @returns {Promise.<Array.<*>>}
     */
    async values(query=null) {
        if (query !== null && query instanceof Query) {
            return query.values(this);
        }
        const values = [];
        for (const key of this.keys(query)) {
            values.push(await this.get(key));
        }
        return Promise.resolve(values);
    }

    /**
     * @param {Query|KeyRange} [query]
     * @returns {Promise.<Set.<string>>}
     */
    keys(query=null) {
        if (query !== null && query instanceof Query) {
            return query.keys(this);
        }
        return this._primaryIndex.keys(query);
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    keyStream(callback, ascending=true, query=null) {
        return this._primaryIndex.keyStream(callback, ascending, query);
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    valueStream(callback, ascending=true, query=null) {
        return this._primaryIndex.valueStream(callback, ascending, query);
    }

    /**
     * @param {KeyRange} [query]
     * @returns {Promise.<*>}
     */
    async maxValue(query=null) {
        const maxKey = await this.maxKey(query);
        return this.get(maxKey);
    }

    /**
     * @param {KeyRange} [query]
     * @returns {Promise.<string>}
     */
    async maxKey(query=null) {
        const keys = await this._primaryIndex.maxKeys(query);
        return Set.sampleElement(keys);
    }

    /**
     * @param {KeyRange} [query]
     * @returns {Promise.<*>}
     */
    async minValue(query=null) {
        const minKey = await this.minKey(query);
        return this.get(minKey);
    }

    /**
     * @param {KeyRange} [query]
     * @returns {Promise.<string>}
     */
    async minKey(query=null) {
        const keys = await this._primaryIndex.minKeys(query);
        return Set.sampleElement(keys);
    }

    /**
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        return (await this.keys(query)).size;
    }

    /**
     * @param {string} indexName
     * @returns {IIndex}
     */
    index(indexName) {
        return this._indices.get(indexName);
    }

    /**
     * @param {Transaction} tx
     * @returns {Promise.<boolean>}
     * @protected
     */
    async _apply(tx) {
        if (tx._truncated) {
            await this.truncate();
        }

        for (const key of tx._removed) {
            await this._cache.delete(key);
        }
        for (const [key, value] of tx._modified) {
            await this._cache.set(key, this.encode(value));
        }

        // Update all indices.
        const indexPromises = [
            InMemoryBackend._indexApply(this._primaryIndex, tx)
        ];
        for (const index of this._indices.values()) {
            indexPromises.push(InMemoryBackend._indexApply(index, tx));
        }
        return Promise.all(indexPromises);
    }

    /**
     * @param {InMemoryIndex} index
     * @param {Transaction} tx
     * @returns {Promise}
     * @private
     */
    static async _indexApply(index, tx) {
        if (tx._truncated) {
            await index.truncate();
        }

        for (const key of tx._removed) {
            await index.remove(key, tx._originalValues.get(key));
        }
        for (const [key, value] of tx._modified) {
            await index.put(key, value, tx._originalValues.get(key));
        }
    }

    /**
     * @returns {Promise}
     */
    async truncate() {
        this._cache.clear();

        // Truncate all indices.
        const indexPromises = [
            this._primaryIndex.truncate()
        ];
        for (const index of this._indices.values()) {
            indexPromises.push(index.truncate());
        }
        return Promise.all(indexPromises);
    }

    /**
     * @param {function(key:string, value:*)} func
     * @returns {Promise}
     */
    async map(func) {
        for (const [key, value] of this._cache) {
            func(key, value);
        }
    }

    /**
     * @param {string} indexName
     * @param {string|Array.<string>} [keyPath]
     * @param {boolean} [multiEntry]
     */
    createIndex(indexName, keyPath, multiEntry=false) {
        keyPath = keyPath || indexName;
        const index = new InMemoryIndex(this, keyPath, multiEntry);
        this._indices.set(indexName, index);
    }

    /**
     * Internal method called to decode a single value.
     * @param {*} value Value to be decoded.
     * @param {string} key Key corresponding to the value.
     * @returns {*} The decoded value.
     */
    decode(value, key) {
        if (value === undefined) {
            return undefined;
        }
        if (this._codec !== null && this._codec !== undefined) {
            return this._codec.decode(value, key);
        }
        return value;
    }

    /**
     * Internal method called to encode a single value.
     * @param {*} value Value to be encoded.
     * @returns {*} The encoded value.
     */
    encode(value) {
        if (value === undefined) {
            return undefined;
        }
        if (this._codec !== null && this._codec !== undefined) {
            return this._codec.encode(value);
        }
        return value;
    }

    /** @type {string} The own table name. */
    get tableName() {
        return this._tableName;
    }

    /**
     * Returns the necessary information in order to flush a combined transaction.
     * @param {Transaction} tx The transaction that should be applied to this backend.
     * @returns {Promise.<*|function():Promise>} Either the tableName if this is a native, persistent backend
     * or a function that effectively applies the transaction to non-persistent backends.
     */
    async applyCombined(tx) {
        return () => this._apply(tx);
    }
}
Class.register(InMemoryBackend);

/**
 * This class represents range queries on an index (primary and secondary).
 */
class KeyRange {
    /**
     * This constructor is only used internally.
     * See static methods for constructing a KeyRange object.
     * @param {*} lower
     * @param {*} upper
     * @param {boolean} lowerOpen
     * @param {boolean} upperOpen
     * @private
     */
    constructor(lower, upper, lowerOpen, upperOpen) {
        this._lower = lower;
        this._upper = upper;
        this._lowerOpen = lowerOpen;
        this._upperOpen = upperOpen;
    }

    /** @type {*} The lower bound of the range. */
    get lower() {
        return this._lower;
    }

    /** @type {*} The upper bound of the range. */
    get upper() {
        return this._upper;
    }

    /** @type {boolean} Whether the lower bound is NOT part of the range. */
    get lowerOpen() {
        return this._lowerOpen;
    }

    /** @type {boolean} Whether the upper bound is NOT part of the range. */
    get upperOpen() {
        return this._upperOpen;
    }

    /** @type {boolean} Whether it is a query for an exact match. */
    get exactMatch() {
        return this._lower === this._upper && !this._lowerOpen && !this.upperOpen;
    }

    /**
     * Returns true if the given key is included in this range.
     * @param {*} key The key to test for.
     * @returns {boolean} True, if the key is included in the range and false otherwise.
     */
    includes(key) {
        return (this._lower === undefined
                || this._lower < key
                || (!this._lowerOpen && this._lower === key))
            && (this._upper === undefined
                || this._upper > key
                || (!this._upperOpen && this._upper === key));
    }

    /**
     * If upperOpen is false, all keys ≤ upper,
     * all keys < upper otherwise.
     * @param {*} upper The upper bound.
     * @param {boolean} upperOpen Whether the upper bound is NOT part of the range.
     * @returns {KeyRange} The corresponding KeyRange object.
     */
    static upperBound(upper, upperOpen=false) {
        return new KeyRange(undefined, upper, false, upperOpen);
    }

    /**
     * If lowerOpen is false, all keys ≥ lower,
     * all keys > lower otherwise.
     * @param {*} lower The lower bound.
     * @param {boolean} lowerOpen Whether the lower bound is NOT part of the range.
     * @returns {KeyRange} The corresponding KeyRange object.
     */
    static lowerBound(lower, lowerOpen=false) {
        return new KeyRange(lower, undefined, lowerOpen, false);
    }

    /**
     * A range bounded by both a lower and upper bound.
     * lowerOpen and upperOpen decide upon whether < (open) or ≤ (inclusive) comparisons
     * should be used for comparison.
     * @param {*} lower The lower bound.
     * @param {*} upper The upper bound.
     * @param {boolean} lowerOpen Whether the lower bound is NOT part of the range.
     * @param {boolean} upperOpen Whether the upper bound is NOT part of the range.
     * @returns {KeyRange} The corresponding KeyRange object.
     */
    static bound(lower, upper, lowerOpen=false, upperOpen=false) {
        return new KeyRange(lower, upper, lowerOpen, upperOpen);
    }

    /**
     * A range matching only exactly one value.
     * @param {*} value The value to match.
     * @returns {KeyRange} The corresponding KeyRange object.
     */
    static only(value) {
        return new KeyRange(value, value, false, false);
    }
}
Class.register(KeyRange);

/**
 * This is the main implementation of an object store.
 * It uses a specified backend (which itself implements the very same interface)
 * and builds upon this backend to answer queries.
 * The main task of this object store is to manage transactions
 * and ensure read isolation on these transactions.
 * @implements {IObjectStore}
 * @implements {ICommittable}
 */
class ObjectStore {
    /**
     * Creates a new object store based on a backend and an underlying database.
     * The database is only used to determine the connection status.
     * @param {IBackend} backend The backend underlying this object store.
     * @param {JungleDB} db The database underlying the backend.
     */
    constructor(backend, db) {
        this.__backend = backend;
        this._db = db;
        /** @type {Array.<Transaction>} */
        this._stateStack = [];
        /**
         * Maps transactions to their base states.
         * @type {Map.<number|string,number|string>}
         */
        this._txBaseStates = new Map();
        /**
         * Maps transactions to their base states.
         * @type {Map.<number|string,IObjectStore>}
         */
        this._transactions = new Map();
        this._transactions.set(ObjectStore.BACKEND_ID, this.__backend);
        /**
         * Maps base states to their open child transactions.
         * @type {Map.<number|string,Set.<number>>}
         */
        this._openTransactions = new Map();
        this._openTransactions.set(ObjectStore.BACKEND_ID, new Set());
        /**
         * Set of base states already committed to.
         * @type {Set.<number|string>}
         */
        this._closedBaseStates = new Set();

        /**
         * The set of currently open snapshots.
         * @type {Set.<Snapshot>}
         */
        this._snapshotManager = new SnapshotManager();

        this._synchronizer = new Synchronizer();
    }

    /** @type {JungleDB} */
    get jungleDB() {
        return this._db;
    }

    /** @type {boolean} */
    get connected() {
        return this.__backend.connected;
    }

    /** @type {IObjectStore} */
    get _currentState() {
        return this._stateStack.length > 0 ? this._stateStack[this._stateStack.length - 1] : this.__backend;
    }

    /** @type {number|string} */
    get _currentStateId() {
        return this._stateStack.length > 0 ? this._stateStack[this._stateStack.length - 1].id : ObjectStore.BACKEND_ID;
    }

    /**
     * A map of index names to indices.
     * The index names can be used to access an index.
     * @type {Map.<string,IIndex>}
     */
    get indices() {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.indices;
    }

    /**
     * Returns a promise of the object stored under the given primary key.
     * Resolves to undefined if the key is not present in the object store.
     * @param {string} key The primary key to look for.
     * @returns {Promise.<*>} A promise of the object stored under the given key, or undefined if not present.
     */
    get(key) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.get(key);
    }

    /**
     * Inserts or replaces a key-value pair.
     * Implicitly creates a transaction for this operation and commits it.
     * @param {string} key The primary key to associate the value with.
     * @param {*} value The value to write.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async put(key, value) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        const tx = this.transaction();
        await tx.put(key, value);
        return tx.commit();
    }

    /**
     * Removes the key-value pair of the given key from the object store.
     * Implicitly creates a transaction for this operation and commits it.
     * @param {string} key The primary key to delete along with the associated object.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async remove(key) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        const tx = this.transaction();
        await tx.remove(key);
        return tx.commit();
    }

    /**
     * Returns a promise of a set of keys fulfilling the given query.
     * If the optional query is not given, it returns all keys in the object store.
     * If the query is of type KeyRange, it returns all keys of the object store being within this range.
     * If the query is of type Query, it returns all keys fulfilling the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to the query.
     */
    keys(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        if (query !== null && query instanceof Query) {
            return query.keys(this._currentState);
        }
        return this._currentState.keys(query);
    }

    /**
     * Returns a promise of an array of objects whose primary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the object store.
     * If the query is of type KeyRange, it returns all objects whose primary keys are within this range.
     * If the query is of type Query, it returns all objects whose primary keys fulfill the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    values(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        if (query !== null && query instanceof Query) {
            return query.values(this._currentState);
        }
        return this._currentState.values(query);
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    keyStream(callback, ascending=true, query=null) {
        return this._currentState.keyStream(callback, ascending, query);
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    valueStream(callback, ascending=true, query=null) {
        return this._currentState.valueStream(callback, ascending, query);
    }

    /**
     * Returns a promise of the object whose primary key is maximal for the given range.
     * If the optional query is not given, it returns the object whose key is maximal.
     * If the query is of type KeyRange, it returns the object whose primary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    maxValue(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.maxValue(query);
    }

    /**
     * Returns a promise of the key being maximal for the given range.
     * If the optional query is not given, it returns the maximal key.
     * If the query is of type KeyRange, it returns the key being maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    maxKey(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.maxKey(query);
    }

    /**
     * Returns a promise of the key being minimal for the given range.
     * If the optional query is not given, it returns the minimal key.
     * If the query is of type KeyRange, it returns the key being minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    minKey(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.minKey(query);
    }

    /**
     * Returns a promise of the object whose primary key is minimal for the given range.
     * If the optional query is not given, it returns the object whose key is minimal.
     * If the query is of type KeyRange, it returns the object whose primary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    minValue(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.minValue(query);
    }

    /**
     * Returns the count of entries in the given range.
     * If the optional query is not given, it returns the count of entries in the object store.
     * If the query is of type KeyRange, it returns the count of entries within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    count(query=null) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.count(query);
    }

    /**
     * This method is only used by transactions internally to commit themselves to the corresponding object store.
     * Thus, the tx argument is non-optional.
     * A call to this method checks whether the given transaction can be applied and pushes it to
     * the stack of applied transactions. When there is no other transaction requiring to enforce
     * read isolation, the state will be flattened and all transactions will be applied to the backend.
     * @param {Transaction} tx The transaction to be applied.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @protected
     */
    async commit(tx) {
        if (!this._isCommittable(tx)) {
            await this.abort(tx);
            return false;
        }
        await this._commitInternal(tx);
        return true;
    }

    /**
     * Is used to probe whether a transaction can be committed.
     * This, for example, includes a check whether another transaction has already been committed.
     * @protected
     * @param {Transaction} tx The transaction to be applied.
     * @returns {boolean} Whether a commit will be successful.
     */
    _isCommittable(tx) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        if (!(tx instanceof Transaction) || tx.state !== Transaction.STATE.OPEN || !this._txBaseStates.has(tx.id)) {
            throw new Error('Can only commit open transactions');
        }

        const baseState = this._txBaseStates.get(tx.id);

        // Another transaction was already committed.
        return !this._closedBaseStates.has(baseState);
    }

    /**
     * Commits the transaction to the backend.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @protected
     */
    async _commitBackend() {
        throw new Error('Cannot commit object stores');
    }

    /**
     * Is used to commit the transaction.
     * @protected
     * @param {Transaction} tx The transaction to be applied.
     * @returns {Promise} A promise that resolves upon successful application of the transaction.
     */
    async _commitInternal(tx) {
        const baseState = this._txBaseStates.get(tx.id);
        const openTransactions = this._openTransactions.get(baseState);
        openTransactions.delete(tx.id);
        const numOpenTransactions = openTransactions.size;


        // Create new layer on stack (might be immediately removed by a state flattening).
        if (this._stateStack.length >= ObjectStore.MAX_STACK_SIZE) {
            Log.e(ObjectStore, `Transaction stack size exceeded ${this.toStringFull()}`);
            throw new Error('Transaction stack size exceeded');
        }
        this._stateStack.push(tx);
        this._openTransactions.set(tx.id, new Set());
        this._closedBaseStates.add(baseState);

        // If this is the last transaction, we push our changes to the underlying layer.
        // This only works if the given transaction does not have dependencies or the current state is the backend.
        if (numOpenTransactions === 0 && (tx.dependency === null || baseState === ObjectStore.BACKEND_ID)) {
            // The underlying layer *has to be* the last one in our stack.
            await this._flattenState(tx);
        }
    }

    /**
     * Allows to change the backend of a Transaction when the state has been flushed.
     * @param backend
     * @protected
     */
    set _backend(backend) {
        throw new Error('Unsupported operation');
    }

    /**
     * @tyoe {IBackend}
     * @protected
     */
    get _backend() {
        return this.__backend;
    }

    /**
     * This method is only used by transactions internally to abort themselves at the corresponding object store.
     * Thus, the tx argument is non-optional.
     * @param {Transaction} tx The transaction to be aborted.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @protected
     */
    async abort(tx) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');

        if (tx instanceof Snapshot) {
            return this._snapshotManager.abortSnapshot(tx);
        }

        if (!(tx instanceof Transaction) || tx.state !== Transaction.STATE.OPEN || !this._txBaseStates.has(tx.id)) {
            throw new Error('Can only abort open transactions');
        }
        const baseState = this._txBaseStates.get(tx.id);

        const openTransactions = this._openTransactions.get(baseState);
        openTransactions.delete(tx.id);
        const numOpenTransactions = openTransactions.size;
        // Cleanup.
        this._txBaseStates.delete(tx.id);
        this._transactions.delete(tx.id);

        if (numOpenTransactions === 0) {
            await this._flattenState();
        }
        return true;
    }

    /**
     * This internal method applies a transaction to the current state
     * and tries flattening the stack of transactions.
     * @param {Transaction} [tx] An optional transaction to apply to the current state.
     * @returns {Promise.<boolean>} If a tx is given, this boolean indicates whether the state has been merged.
     * If tx is not given, the return value is false and does not convey a meaning.
     * @private
     */
    _flattenState(tx) {
        return this._synchronizer.push(() => this._flattenStateInternal(tx));
    }

    /**
     * This internal method applies a transaction to the current state
     * and tries flattening the stack of transactions.
     * @param {Transaction} [tx] An optional transaction to apply to the current state.
     * @returns {Promise.<boolean>} If a tx is given, this boolean indicates whether the state has been merged.
     * If tx is not given, the return value is false and does not convey a meaning.
     * @private
     */
    async _flattenStateInternal(tx) {
        // If there is a tx argument, merge it with the current state.
        if (tx && (tx instanceof Transaction)) {
            // Check whether the state can be flattened.
            // For this, the following conditions have to hold:
            // 1. the base state does not have open transactions
            // 2. the base state is either the backend or neither the base state nor tx have an onFlush callback
            const baseState = this._txBaseStates.get(tx.id);
            if (this._openTransactions.get(baseState).size > 0) {
                return false;
            }
            if (tx.dependency !== null && baseState !== ObjectStore.BACKEND_ID) {
                return false;
            }

            // Applying is possible.
            // We apply it first and upon successful application, we update transactions.
            // This way, we ensure that intermediate reads still work and that transactions
            // are still consistent even if the application fails.
            const backend = this._transactions.get(baseState);
            const cleanup = () => {
                // Change pointers in child transactions.
                if (this._openTransactions.has(tx.id)) {
                    for (const txId of this._openTransactions.get(tx.id)) {
                        const childTx = this._transactions.get(txId);
                        childTx._backend = backend;
                        this._txBaseStates.set(childTx.id, baseState);
                    }
                }
                // If tx is in the state stack (i.e., a closed base state), update its potential closed child.
                if (this._closedBaseStates.has(tx.id)) {
                    const index = this._stateStack.indexOf(tx);
                    if (index + 1 < this._stateStack.length) {
                        const childTx = this._stateStack[index + 1];
                        childTx._backend = backend;
                        this._txBaseStates.set(childTx.id, baseState);
                    }
                }

                // Copy relevant baseState data to new base state.
                // If tx was a closed base state, the new base state also is.
                // Otherwise remove the base state from the closed states, since we just flushed.
                if (this._closedBaseStates.has(tx.id)) {
                    this._closedBaseStates.add(baseState);
                    this._closedBaseStates.delete(tx.id);
                } else {
                    this._closedBaseStates.delete(baseState);
                }
                // The open transactions transfer from the tx to the open transactions' new base state.
                if (this._openTransactions.has(tx.id)) {
                    this._openTransactions.set(baseState, this._openTransactions.get(tx.id));
                    this._openTransactions.delete(tx.id);
                }

                // Cleanup.
                this._txBaseStates.delete(tx.id);
                this._transactions.delete(tx.id);

                // Look for tx on stack and remove it.
                const statePosition = this._stateStack.indexOf(tx);
                if (statePosition >= 0) {
                    this._stateStack.splice(statePosition, 1);
                }

                this._flattenState();
            };

            if (tx.dependency === null) {
                // If we apply to the backend, update the snapshots.
                if (baseState === ObjectStore.BACKEND_ID) {
                    await this._snapshotManager.applyTx(tx, backend);
                }
                await backend._apply(tx);
                cleanup();
                return true;
            } else {
                // We apply to the backend, so also update snapshots before the flush.
                return await tx.dependency.onFlushable(tx, cleanup, () => this._snapshotManager.applyTx(tx, backend));
            }
        } else {
            // Check both ends of the stack.
            // Start with the easy part: The last state.
            // Start flattening at the end.
            while (this._stateStack.length > 0) {
                if (!(await this._flattenStateInternal(this._currentState))) {
                    break;
                }
            }
            // Then try flattening from the start.
            while (this._stateStack.length > 0) {
                if (!(await this._flattenStateInternal(this._stateStack[0]))) {
                    break;
                }
            }
            return false;
        }
    }

    /**
     * Returns the index of the given name.
     * If the index does not exist, it returns undefined.
     * @param {string} indexName The name of the requested index.
     * @returns {IIndex} The index associated with the given name.
     */
    index(indexName) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        return this._currentState.index(indexName);
    }

    /**
     * Creates a new secondary index on the object store.
     * Currently, all secondary indices are non-unique.
     * They are defined by a key within the object or alternatively a path through the object to a specific subkey.
     * For example, ['a', 'b'] could be used to use 'key' as the key in the following object:
     * { 'a': { 'b': 'key' } }
     * Secondary indices may be multiEntry, i.e., if the keyPath resolves to an iterable object, each item within can
     * be used to find this entry.
     * If a new object does not possess the key path associated with that index, it is simply ignored.
     *
     * This function may only be called before the database is connected.
     * Moreover, it is only executed on database version updates or on first creation.
     * @param {string} indexName The name of the index.
     * @param {string|Array.<string>} [keyPath] The path to the key within the object. May be an array for multiple levels.
     * @param {boolean} [multiEntry]
     */
    createIndex(indexName, keyPath, multiEntry=false) {
        return this.__backend.createIndex(indexName, keyPath, multiEntry);
    }

    /**
     * Deletes a secondary index from the object store.
     * @param indexName
     * @returns {Promise} The promise resolves after deleting the index.
     */
    deleteIndex(indexName) {
        return this.__backend.deleteIndex(indexName);
    }

    /**
     * Creates a new transaction, ensuring read isolation
     * on the most recently successfully committed state.
     * @param {boolean} [enableWatchdog]
     * @returns {Transaction} The transaction object.
     */
    transaction(enableWatchdog=true) {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        const tx = new Transaction(this, this._currentState, this, enableWatchdog);
        this._transactions.set(tx.id, tx);
        this._txBaseStates.set(tx.id, this._currentStateId);
        this._openTransactions.get(this._currentStateId).add(tx.id);
        return tx;
    }

    /**
     * Creates an in-memory snapshot of the current state.
     * This snapshot only maintains the differences between the state at the time of the snapshot
     * and the current state.
     * To stop maintaining the snapshot, it has to be aborted.
     * @returns {Snapshot}
     */
    snapshot() {
        if (this._currentStateId !== ObjectStore.BACKEND_ID) {
            return this._currentState.snapshot();
        }
        return this._snapshotManager.createSnapshot(this, this._currentState);
    }

    /**
     * An object store is strongly connected to a backend.
     * Hence, it does not store anything by itself and the _apply method is not supported.
     * @param {Transaction} tx
     * @returns {Promise.<boolean>}
     * @protected
     */
    async _apply(tx) {
        throw new Error('Unsupported operation');
    }

    /**
     * Empties the object store.
     * @returns {Promise} The promise resolves after emptying the object store.
     */
    async truncate() {
        if (!this.__backend.connected) throw new Error('JungleDB is not connected');
        const tx = this.transaction();
        await tx.truncate();
        return tx.commit();
    }

    /**
     * Closes the object store and potential connections.
     * @returns {Promise} The promise resolves after closing the object store.
     */
    close() {
        // TODO perhaps use a different strategy here
        if (this._stateStack.length > 0) {
            throw new Error('Cannot close database while transactions are active');
        }
        return this.__backend.close();
    }

    toStringFull() {
        return `ObjectStore{
    stack=[${this._stateStack.map(tx => `{tx=${tx.toStringShort()}, open=${this._openTransactions.get(tx.id) ? this._openTransactions.get(tx.id).size : 0}}`)}],
    db=${this._db}
}`;
    }

    toString() {
        return `ObjectStore{stackSize=${this._stateStack.length}, db=${this._db}}`;
    }
}
/** @type {number} The maximum number of states to stack. */
ObjectStore.MAX_STACK_SIZE = 10;
ObjectStore.BACKEND_ID = 'backend';
Class.register(ObjectStore);

/**
 * This class represents a Query object.
 * Queries are constructed using the static helper methods.
 */
class Query {
    /**
     * Internal helper method that translates an operation to a KeyRange object.
     * @param {Query.OPERATORS} op The operator of the query.
     * @param {*} value The first operand of the query.
     * @param {*} [value2] The optional second operand of the query.
     * @private
     */
    static _parseKeyRange(op, value, value2) {
        switch (op) {
            case Query.OPERATORS.GT:
                return KeyRange.lowerBound(value, true);
            case Query.OPERATORS.GE:
                return KeyRange.lowerBound(value, false);
            case Query.OPERATORS.LT:
                return KeyRange.upperBound(value, true);
            case Query.OPERATORS.LE:
                return KeyRange.upperBound(value, false);
            case Query.OPERATORS.EQ:
                return KeyRange.only(value);
            case Query.OPERATORS.BETWEEN:
                return KeyRange.bound(value, value2, true, true);
            case Query.OPERATORS.WITHIN:
                return KeyRange.bound(value, value2, false, false);
        }
        throw new Error('Unknown operator');
    }

    /**
     * Returns the conjunction of multiple queries.
     * @param {...Query} var_args The list of queries, which all have to be fulfilled.
     * @returns {Query} The conjunction of the queries.
     */
    static and(var_args) {
        const args = Array.from(arguments);
        return new Query(args, Query.OPERATORS.AND);
    }

    /**
     * Returns the disjunction of multiple queries.
     * @param {...Query} var_args The list of queries, out of which at least one has to be fulfilled.
     * @returns {Query} The disjunction of the queries.
     */
    static or(var_args) {
        const args = Array.from(arguments);
        return new Query(args, Query.OPERATORS.OR);
    }

    /**
     * Returns a query for the max key of an index.
     * @param {string} indexName The name of the index, whose maximal key the query matches.
     * @returns {Query} The query for the max key of the index.
     */
    static max(indexName) {
        return new Query(indexName, Query.OPERATORS.MAX);
    }

    /**
     * Returns a query for the min key of an index.
     * @param {string} indexName The name of the index, whose minimal key the query matches.
     * @returns {Query} The query for the min key of the index.
     */
    static min(indexName) {
        return new Query(indexName, Query.OPERATORS.MIN);
    }

    /**
     * Returns a query that matches all keys of an index that are less than a value.
     * The query matches all keys k, such that k < val.
     * @param {string} indexName The name of the index.
     * @param {*} val The upper bound of the query.
     * @returns {Query} The resulting query object.
     */
    static lt(indexName, val) {
        return new Query(indexName, Query.OPERATORS.LT, val);
    }

    /**
     * Returns a query that matches all keys of an index that are less or equal than a value.
     * The query matches all keys k, such that k ≤ val.
     * @param {string} indexName The name of the index.
     * @param {*} val The upper bound of the query.
     * @returns {Query} The resulting query object.
     */
    static le(indexName, val) {
        return new Query(indexName, Query.OPERATORS.LE, val);
    }

    /**
     * Returns a query that matches all keys of an index that are greater than a value.
     * The query matches all keys k, such that k > val.
     * @param {string} indexName The name of the index.
     * @param {*} val The lower bound of the query.
     * @returns {Query} The resulting query object.
     */
    static gt(indexName, val) {
        return new Query(indexName, Query.OPERATORS.GT, val);
    }

    /**
     * Returns a query that matches all keys of an index that are greater or equal than a value.
     * The query matches all keys k, such that k ≥ val.
     * @param {string} indexName The name of the index.
     * @param {*} val The lower bound of the query.
     * @returns {Query} The resulting query object.
     */
    static ge(indexName, val) {
        return new Query(indexName, Query.OPERATORS.GE, val);
    }

    /**
     * Returns a query that matches all keys of an index that equal to a value.
     * The query matches all keys k, such that k = val.
     * @param {string} indexName The name of the index.
     * @param {*} val The value to look for.
     * @returns {Query} The resulting query object.
     */
    static eq(indexName, val) {
        return new Query(indexName, Query.OPERATORS.EQ, val);
    }

    /**
     * Returns a query that matches all keys of an index that are between two values, excluding the boundaries.
     * The query matches all keys k, such that lower < k < upper.
     * @param {string} indexName The name of the index.
     * @param {*} lower The lower bound.
     * @param {*} upper The upper bound.
     * @returns {Query} The resulting query object.
     */
    static between(indexName, lower, upper) {
        return new Query(indexName, Query.OPERATORS.BETWEEN, lower, upper);
    }

    /**
     * Returns a query that matches all keys of an index that are between two values, including the boundaries.
     * The query matches all keys k, such that lower ≤ k ≤ upper.
     * @param {string} indexName The name of the index.
     * @param {*} lower The lower bound.
     * @param {*} upper The upper bound.
     * @returns {Query} The resulting query object.
     */
    static within(indexName, lower, upper) {
        return new Query(indexName, Query.OPERATORS.WITHIN, lower, upper);
    }

    /**
     * Internal constructor for a query.
     * Should not be called directly.
     * @param {string|Array.<Query>} arg Either a list of queries or an index name (depending on the operator).
     * @param {Query.OPERATORS} op The operator to apply.
     * @param {*} [value] The first operand if applicable.
     * @param {*} [value2] The second operand if applicable.
     * @private
     */
    constructor(arg, op, value, value2) {
        // If first argument is an array of queries, this is a combined query.
        if (Array.isArray(arg)) {
            if (arg.some(it => !(it instanceof Query))) {
                throw new Error('Invalid query');
            }
            if (Query.COMBINED_OPERATORS.indexOf(op) < 0) {
                throw new Error('Unknown operator');
            }
            this._queryType = Query.Type.COMBINED;
            this._queries = arg;
            this._op = op;
        }
        // Otherwise we have a single query.
        else {
            if (Query.RANGE_OPERATORS.indexOf(op) >= 0) {
                this._queryType = Query.Type.RANGE;
                this._keyRange = Query._parseKeyRange(op, value, value2);
            } else if (Query.ADVANCED_OPERATORS.indexOf(op) >= 0) {
                this._queryType = Query.Type.ADVANCED;
                this._op = op;
            } else {
                throw new Error('Unknown operator');
            }
            this._indexName = arg;
        }
    }

    /**
     * Returns a promise of an array of objects fulfilling this query.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to this query.
     */
    async values(objectStore) {
        const keys = await this._execute(objectStore);
        const resultPromises = [];
        for (const key of keys) {
            resultPromises.push(objectStore.get(key));
        }
        return Promise.all(resultPromises);
    }

    /**
     * Returns a promise of a set of keys fulfilling this query.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to this query.
     */
    keys(objectStore) {
        return this._execute(objectStore);
    }

    /**
     * Internal method to execute a query on an object store.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to this query.
     * @private
     */
    async _execute(objectStore) {
        switch (this._queryType) {
            case Query.Type.COMBINED:
                return Promise.resolve(this._executeCombined(objectStore));

            case Query.Type.ADVANCED:
                return Promise.resolve(this._executeAdvanced(objectStore));

            case Query.Type.RANGE:
                return this._executeRange(objectStore);
        }
        return Promise.resolve(new Set());
    }

    /**
     * Internal method for and/or operators.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to this query.
     * @private
     */
    async _executeCombined(objectStore) {
        // Evaluate children.
        const resultPromises = [];
        for (const query of this._queries) {
            resultPromises.push(query._execute(objectStore));
        }
        const results = await Promise.all(resultPromises);

        if (this._op === Query.OPERATORS.AND) {
            // Provide shortcuts.
            if (results.length === 0) {
                return new Set();
            } else if (results.length === 1) {
                return results[0];
            }

            // Set intersection of all keys.
            const firstResult = results.shift();
            const intersection = new Set();
            for (const val of firstResult) {
                if (results.every(result => result.has(val))) {
                    intersection.add(val);
                }
            }
            return intersection;
        } else if (this._op === Query.OPERATORS.OR) {
            // Set union of all keys.
            const union = new Set();
            for (const result of results) {
                result.forEach(val => union.add(val));
            }
            return union;
        }
        return new Set();
    }

    /**
     * Internal method for min/max operators.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to this query.
     * @private
     */
    async _executeAdvanced(objectStore) {
        const index = objectStore.index(this._indexName);
        let results = new Set();
        switch (this._op) {
            case Query.OPERATORS.MAX:
                results = await index.maxKeys();
                break;
            case Query.OPERATORS.MIN:
                results = await index.minKeys();
                break;
        }
        return new Set(results);
    }

    /**
     * Internal method for range operators.
     * @param {IObjectStore} objectStore The object store to execute the query on.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to this query.
     * @private
     */
    async _executeRange(objectStore) {
        const index = objectStore.index(this._indexName);
        return new Set(await index.keys(this._keyRange));
    }
}
/**
 * Enum for supported operators.
 * @enum {number}
 */
Query.OPERATORS = {
    GT: 0,
    GE: 1,
    LT: 2,
    LE: 3,
    EQ: 4,
    // NEQ: 5, not supported
    BETWEEN: 7,
    WITHIN: 8,
    MAX: 9,
    MIN: 10,
    AND: 11,
    OR: 12
};
Query.RANGE_OPERATORS = [
    Query.OPERATORS.GT,
    Query.OPERATORS.GE,
    Query.OPERATORS.LT,
    Query.OPERATORS.LE,
    Query.OPERATORS.EQ,
    Query.OPERATORS.BETWEEN,
    Query.OPERATORS.WITHIN
];
Query.ADVANCED_OPERATORS = [Query.OPERATORS.MAX, Query.OPERATORS.MIN];
Query.COMBINED_OPERATORS = [Query.OPERATORS.AND, Query.OPERATORS.OR];
/**
 * Enum for query types.
 * Each operator belongs to one of these types as specified above.
 * @enum {number}
 */
Query.Type = {
    RANGE: 0,
    ADVANCED: 1,
    COMBINED: 2
};
Class.register(Query);


/**
 * This class constitutes an InMemoryIndex for Transactions.
 * It unifies the results of keys changed during the transaction
 * with the underlying backend.
 */
class TransactionIndex extends InMemoryIndex {
    /**
     * Derives the indices from the backend and returns a new map of transactions.
     * @param {Transaction} objectStore The transaction the index should be based on.
     * @param {IObjectStore} backend The backend underlying the transaction.
     * @returns {Map.<string,TransactionIndex>} A map containing all indices for the transaction.
     */
    static derive(objectStore, backend) {
        const indices = new Map();
        for (const [name, index] of backend.indices) {
            indices.set(name, new TransactionIndex(objectStore, backend, name, index.keyPath, index.multiEntry));
        }
        return indices;
    }

    /** @type {IIndex} The index of the underlying backend. */
    get _index() {
        return this._backend.index(this._databaseDir);
    }

    /**
     * Constructs a new TransactionIndex serving the transaction's changes
     * and unifying the results with the underlying backend.
     * @param {Transaction} objectStore The transaction the index should be based on.
     * @param {IObjectStore} backend The backend underlying the transaction.
     * @param {string|Array.<string>} keyPath The key path of the indexed attribute.
     * @param {boolean} multiEntry Whether the indexed attribute is considered to be iterable or not.
     * @protected
     */
    constructor(objectStore, backend, name, keyPath, multiEntry=false) {
        super(objectStore, keyPath, multiEntry);
        this._backend = backend;
        this._databaseDir = name;
    }

    /**
     * Returns a promise of a set of primary keys, whose associated objects' secondary keys are in the given range.
     * If the optional query is not given, it returns all primary keys in the index.
     * If the query is of type KeyRange, it returns all primary keys for which the secondary key is within this range.
     * @param {KeyRange} [query] Optional query to check the secondary keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of primary keys relevant to the query.
     */
    async keys(query=null) {
        const promises = [];
        if (this._objectStore._truncated) {
            promises.push(new Set());
        } else {
            promises.push(this._index.keys(query));
        }
        promises.push(InMemoryIndex.prototype.keys.call(this, query));
        let [keys, newKeys] = await Promise.all(promises);
        // Remove keys that have been deleted or modified.
        keys = keys.difference(this._objectStore._removed);
        keys = keys.difference(this._objectStore._modified.keys());
        return keys.union(newKeys);
    }

    /**
     * Returns a promise of an array of objects whose secondary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the index.
     * If the query is of type KeyRange, it returns all objects whose secondary keys are within this range.
     * @param {KeyRange} [query] Optional query to check secondary keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    async values(query=null) {
        const keys = await this.keys(query);
        return InMemoryIndex.prototype._retrieveValues.call(this, keys);
    }

    /**
     * Returns a promise of an array of objects whose secondary key is maximal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async maxValues(query=null) {
        const keys = await this.maxKeys(query);
        return InMemoryIndex.prototype._retrieveValues.call(this, keys);
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are maximal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is maximal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async maxKeys(query=null) {
        let backendKeys;
        if (this._objectStore._truncated) {
            backendKeys = new Set();
        } else {
            backendKeys = await this._index.maxKeys(query);
        }

        // Remove keys that have been deleted or modified.
        let sampleElement = Set.sampleElement(backendKeys);
        const value = await this._backend.get(sampleElement);
        let maxIKey = sampleElement ? ObjectUtils.byKeyPath(value, this.keyPath) : undefined;
        backendKeys = backendKeys.difference(this._objectStore._removed);
        backendKeys = backendKeys.difference(this._objectStore._modified.keys());

        while (sampleElement !== undefined && backendKeys.size === 0) {
            const tmpQuery = KeyRange.upperBound(maxIKey, true);
            backendKeys = await this._index.maxKeys(tmpQuery);

            // Remove keys that have been deleted or modified.
            sampleElement = Set.sampleElement(backendKeys);
            const value = await this._backend.get(sampleElement);
            maxIKey = sampleElement ? ObjectUtils.byKeyPath(value, this.keyPath) : undefined;
            backendKeys = backendKeys.difference(this._objectStore._removed);
            backendKeys = backendKeys.difference(this._objectStore._modified.keys());

            // If we get out of the range, stop here.
            if (maxIKey && query !== null && !query.includes(maxIKey)) {
                backendKeys = new Set();
                break;
            }
        }

        const newKeys = await InMemoryIndex.prototype.maxKeys.call(this, query);

        if (backendKeys.size === 0) {
            return newKeys;
        } else if (newKeys.size === 0) {
            return backendKeys;
        }

        // Both contain elements, check which one is larger.
        const valueTx = await this._objectStore.get(Set.sampleElement(newKeys));

        const iKeyBackend = maxIKey;
        const iKeyTx = ObjectUtils.byKeyPath(valueTx, this.keyPath);

        if (iKeyBackend > iKeyTx) {
            return backendKeys;
        } else if (iKeyBackend < iKeyTx) {
            return newKeys;
        }
        return backendKeys.union(newKeys);
    }

    /**
     * Returns a promise of an array of objects whose secondary key is minimal for the given range.
     * If the optional query is not given, it returns the objects whose secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the objects whose secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of array of objects relevant to the query.
     */
    async minValues(query=null) {
        const keys = await this.minKeys(query);
        return InMemoryIndex.prototype._retrieveValues.call(this, keys);
    }

    /**
     * Returns a promise of a set of primary keys, whose associated secondary keys are minimal for the given range.
     * If the optional query is not given, it returns the set of primary keys, whose associated secondary key is minimal within the index.
     * If the query is of type KeyRange, it returns the set of primary keys, whose associated secondary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<*>>} A promise of the key relevant to the query.
     */
    async minKeys(query=null) {
        let backendKeys;
        if (this._objectStore._truncated) {
            backendKeys = new Set();
        } else {
            backendKeys = await this._index.minKeys(query);
        }

        // Remove keys that have been deleted or modified.
        let sampleElement = Set.sampleElement(backendKeys);
        const value = await this._backend.get(sampleElement);
        let minIKey = sampleElement ? ObjectUtils.byKeyPath(value, this.keyPath) : undefined;
        backendKeys = backendKeys.difference(this._objectStore._removed);
        backendKeys = backendKeys.difference(this._objectStore._modified.keys());

        while (sampleElement !== undefined && backendKeys.size === 0) {
            const tmpQuery = KeyRange.lowerBound(minIKey, true);
            backendKeys = await this._index.minKeys(tmpQuery);

            // Remove keys that have been deleted or modified.
            sampleElement = Set.sampleElement(backendKeys);
            const value = await this._backend.get(sampleElement);
            minIKey = sampleElement ? ObjectUtils.byKeyPath(value, this.keyPath) : undefined;
            backendKeys = backendKeys.difference(this._objectStore._removed);
            backendKeys = backendKeys.difference(this._objectStore._modified.keys());

            // If we get out of the range, stop here.
            if (minIKey && query !== null && !query.includes(minIKey)) {
                backendKeys = new Set();
                break;
            }
        }

        const newKeys = await InMemoryIndex.prototype.minKeys.call(this, query);

        if (backendKeys.size === 0) {
            return newKeys;
        } else if (newKeys.size === 0) {
            return backendKeys;
        }

        // Both contain elements, check which one is larger.
        const valueTx = await this._objectStore.get(Set.sampleElement(newKeys));

        const iKeyBackend = minIKey;
        const iKeyTx = ObjectUtils.byKeyPath(valueTx, this.keyPath);

        if (iKeyBackend < iKeyTx) {
            return backendKeys;
        } else if (iKeyBackend > iKeyTx) {
            return newKeys;
        }
        return backendKeys.union(newKeys);
    }

    /**
     * Returns the count of entries, whose secondary key is in the given range.
     * If the optional query is not given, it returns the count of entries in the index.
     * If the query is of type KeyRange, it returns the count of entries, whose secondary key is within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        // Unfortunately, we cannot do better than getting keys + counting.
        return (await this.keys(query)).size;
    }
}
Class.register(TransactionIndex);

/**
 * Transactions are created by calling the transaction method on an ObjectStore object.
 * Transactions ensure read-isolation.
 * On a given state, only *one* transaction can be committed successfully.
 * Other transactions based on the same state will end up in a conflicted state if committed.
 * Transactions opened after the successful commit of another transaction will be based on the
 * new state and hence can be committed again.
 * @implements {IObjectStore}
 * @implements {ICommittable}
 */
class Transaction {
    /**
     * This constructor should only be called by an ObjectStore object.
     * Our transactions have a watchdog enabled by default,
     * logging a warning after a certain time specified by WATCHDOG_TIMER.
     * This helps to detect unclosed transactions preventing to store the state in
     * the persistent backend.
     * @param {ObjectStore} objectStore The object store this transaction belongs to.
     * @param {IObjectStore} backend The backend on which the transaction is based,
     * i.e., another transaction or the real database.
     * @param {ICommittable} [managingBackend] The object store managing the transactions,
     * i.e., the ObjectStore object.
     * @param {boolean} [enableWatchdog] If this is is set to true (default),
     * a warning will be logged if left open for longer than WATCHDOG_TIMER.
     * @protected
     */
    constructor(objectStore, backend, managingBackend, enableWatchdog=true) {
        this._id = Transaction._instanceCount++;
        this._objectStore = objectStore;
        this.__backend = backend;
        /** @type {ICommittable} */
        this._managingBackend = managingBackend || backend;
        this._modified = new Map();
        this._removed = new Set();
        this._originalValues = new Map();
        this._truncated = false;
        this._indices = TransactionIndex.derive(this, backend);

        this._state = Transaction.STATE.OPEN;

        // Keep track of nested transactions.
        /** @type {Set.<Transaction>} */
        this._nested = new Set();
        this._nestedCommitted = false;

        // Handle dependencies due to cross-objectstore transactions.
        /** @type {CombinedTransaction} */
        this._dependency = null;

        this._snapshotManager = new SnapshotManager();

        this._startTime = Date.now();
        this._enableWatchdog = enableWatchdog;
        if (this._enableWatchdog) {
            this._watchdog = setTimeout(() => {
                Log.w(Transaction, `Violation: tx id ${this._id} took longer than expected (still open after ${Transaction.WATCHDOG_TIMER/1000}s), ${this.toString()}.`);
            }, Transaction.WATCHDOG_TIMER);
        }
    }

    /** @type {ObjectStore} */
    get objectStore() {
        return this._objectStore;
    }

    /** @type {boolean} */
    get nested() {
        return this._managingBackend instanceof Transaction;
    }

    /**
     * @type {CombinedTransaction} If existent, a combined transaction encompassing this object.
     */
    get dependency() {
        return this._dependency;
    }

    /** @type {boolean} */
    get connected() {
        return this._managingBackend.connected;
    }

    /** @type {number} A unique transaction id. */
    get id() {
        return this._id;
    }

    /**
     * A map of index names to indices.
     * The index names can be used to access an index.
     * @type {Map.<string,IIndex>}
     */
    get indices() {
        return this._indices;
    }

    /**
     * The transaction's current state.
     * @returns {Transaction.STATE}
     */
    get state() {
        return this._state;
    }

    /**
     * Internally applies a transaction to the transaction's state.
     * This needs to be done in batch (as a db level transaction), i.e., either the full state is updated
     * or no changes are applied.
     * @param {Transaction} tx The transaction to apply.
     * @returns {Promise} The promise resolves after applying the transaction.
     * @protected
     */
    async _apply(tx) {
        if (!(tx instanceof Transaction)) {
            throw new Error('Can only apply transactions');
        }

        // First handle snapshots.
        await this._snapshotManager.applyTx(tx, this);

        this._applySync(tx);
    }

    /**
     * Non-async version of _apply that does not update snapshots.
     * Internally applies a transaction to the transaction's state.
     * This needs to be done in batch (as a db level transaction), i.e., either the full state is updated
     * or no changes are applied.
     * @param {Transaction} tx The transaction to apply.
     * @protected
     */
    _applySync(tx) {
        if (tx._truncated) {
            this._truncateSync();
        }
        for (const [key, value] of tx._modified) {
            // If this transaction has key in its originalValues, we use it.
            // Otherwise, the original value has to coincide with the transaction's stored original value.
            let oldValue;
            if (this._originalValues.has(key)) {
                oldValue = this._originalValues.get(key);
            } else {
                oldValue = tx._originalValues.get(key);
                this._originalValues.set(key, oldValue);
            }

            this._put(key, value, oldValue);
        }
        for (const key of tx._removed) {
            // If this transaction has key in its originalValues, we use it.
            // Otherwise, the original value has to coincide with the transaction's stored original value.
            let oldValue;
            if (this._originalValues.has(key)) {
                oldValue = this._originalValues.get(key);
            } else {
                oldValue = tx._originalValues.get(key);
                this._originalValues.set(key, oldValue);
            }

            this._remove(key, oldValue);
        }
    }

    /**
     * Empties the object store.
     * @returns {Promise} The promise resolves after emptying the object store.
     */
    async truncate() {
        return this._truncateSync();
    }

    /**
     * Non-async variant to empty the object store.
     * @protected
     */
    _truncateSync() {
        if (this._state !== Transaction.STATE.OPEN) {
            throw new Error('Transaction already closed');
        }

        this._truncated = true;
        this._modified.clear();
        this._removed.clear();
        this._originalValues.clear();

        // Update indices.
        for (const index of this._indices.values()) {
            index.truncate();
        }
    }

    /**
     * Commits a transaction to the underlying backend.
     * The state is only written to the persistent backend if no other transaction is open.
     * If the commit was successful, new transactions will always be based on the new state.
     * There are two outcomes for a commit:
     * If there was no other transaction committed that was based on the same state,
     * it will be successful and change the transaction's state to COMMITTED (returning true).
     * Otherwise, the state will be CONFLICTED and the method will return false.
     * @param {Transaction} [tx] The transaction to be applied, only used internally.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async commit(tx) {
        // Transaction is given, so check whether this is a nested one.
        if (tx !== undefined) {
            if (!this._isCommittable(tx)) {
                await this.abort(tx);
                return false;
            }
            await this._commitInternal(tx);
            return true;
        }

        if (this._dependency !== null) {
            return this._dependency.commit();
        }

        return this._commitBackend();
    }

    /**
     * Commits the transaction to the backend.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @protected
     */
    async _commitBackend() {
        if (this._state !== Transaction.STATE.OPEN) {
            throw new Error('Transaction already closed or in nested state');
        }
        if (this._enableWatchdog) {
            clearTimeout(this._watchdog);
        }
        const commitStart = Date.now();
        if (await this._managingBackend.commit(this)) {
            this._state = Transaction.STATE.COMMITTED;
            this._performanceCheck(commitStart, 'commit');
            this._performanceCheck();
            return true;
        } else {
            this._state = Transaction.STATE.CONFLICTED;
            this._performanceCheck(commitStart, 'commit');
            this._performanceCheck();
            return false;
        }
    }

    /**
     * @param {number} [startTime]
     * @param {string} [functionName]
     * @private
     */
    _performanceCheck(startTime=this._startTime, functionName=null) {
        const executionTime = Date.now() - startTime;
        functionName = functionName ? ` function '${functionName}'` : '';
        if (executionTime > Transaction.WATCHDOG_TIMER) {
            Log.w(Transaction, `Violation: tx id ${this._id}${functionName} took ${(executionTime/1000).toFixed(2)}s (${this.toString()}).`);
        }
    }

    /**
     * Is used to probe whether a transaction can be committed.
     * This, for example, includes a check whether another transaction has already been committed.
     * @protected
     * @param {Transaction} [tx] The transaction to be applied, if not given checks for the this transaction.
     * @returns {boolean} Whether a commit will be successful.
     */
    _isCommittable(tx) {
        if (tx !== undefined) {
            // Make sure transaction is based on this transaction.
            if (!this._nested.has(tx) || tx.state !== Transaction.STATE.OPEN) {
                throw new Error('Can only commit open, nested transactions');
            }
            return !this._nestedCommitted;
        }
        return this._managingBackend._isCommittable(this);
    }

    /**
     * Is used to commit the transaction to the in memory state.
     * @protected
     * @param {Transaction} tx The transaction to be applied.
     * @returns {Promise} A promise that resolves upon successful application of the transaction.
     */
    async _commitInternal(tx) {
        this._nested.delete(tx);
        // Apply nested transaction.
        this._nestedCommitted = true;
        await this._apply(tx);
        // If there are no more nested transactions, change back to OPEN state.
        if (this._nested.size === 0) {
            this._state = Transaction.STATE.OPEN;
            this._nestedCommitted = false;
        }
    }

    /**
     * Allows to change the backend of a Transaction when the state has been flushed.
     * @param backend
     * @protected
     */
    set _backend(backend) {
        this.__backend = backend;
    }

    /**
     * Aborts a transaction and (if this was the last open transaction) potentially
     * persists the most recent, committed state.
     * @param {Transaction} [tx] The transaction to be applied, only used internally.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async abort(tx) {
        // Transaction is given, so check whether this is a nested one.
        if (tx !== undefined) {
            // Handle snapshots.
            if (tx instanceof Snapshot) {
                return this._snapshotManager.abortSnapshot(tx);
            }

            // Make sure transaction is based on this transaction.
            if (!this._nested.has(tx) || tx.state !== Transaction.STATE.OPEN) {
                throw new Error('Can only abort open, nested transactions');
            }
            this._nested.delete(tx);
            // If there are no more nested transactions, change back to OPEN state.
            if (this._nested.size === 0) {
                this._state = Transaction.STATE.OPEN;
                this._nestedCommitted = false;
            }
            return true;
        }

        if (this._dependency !== null) {
            return this._dependency.abort();
        }

        return this._abortBackend();
    }

    /**
     * Aborts a transaction on the backend.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async _abortBackend() {
        if (this._state === Transaction.STATE.ABORTED || this._state === Transaction.STATE.CONFLICTED) {
            return true;
        }
        if (this._state !== Transaction.STATE.OPEN && this._state !== Transaction.STATE.NESTED) {
            throw new Error('Transaction already closed');
        }
        if (this._state === Transaction.STATE.NESTED) {
            await Promise.all(Array.from(this._nested).map(tx => tx.abort()));
        }
        if (this._enableWatchdog) {
            clearTimeout(this._watchdog);
        }
        const abortStart = Date.now();
        await this._managingBackend.abort(this);
        this._state = Transaction.STATE.ABORTED;
        this._performanceCheck(abortStart, 'abort');
        this._performanceCheck();
        return true;
    }

    /**
     * Returns a promise of the object stored under the given primary key.
     * Resolves to undefined if the key is not present in the object store.
     * @param {string} key The primary key to look for.
     * @returns {Promise.<*>} A promise of the object stored under the given key, or undefined if not present.
     */
    async get(key) {
        // Order is as follows:
        // 1. check if removed,
        // 2. check if modified,
        // 3. check if truncated
        // 4. request from backend
        if (this._removed.has(key)) {
            return undefined;
        }
        if (this._modified.has(key)) {
            return this._modified.get(key);
        }
        if (this._truncated) {
            return undefined;
        }
        return await this.__backend.get(key);
    }

    /**
     * Inserts or replaces a key-value pair.
     * @param {string} key The primary key to associate the value with.
     * @param {*} value The value to write.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    async put(key, value) {
        if (this._state !== Transaction.STATE.OPEN) {
            throw new Error('Transaction already closed');
        }

        const oldValue = await this.get(key);

        // Save for indices.
        if (!this._originalValues.has(key)) {
            this._originalValues.set(key, oldValue);
        }

        this._put(key, value, oldValue);
    }

    /**
     * Internal method for inserting/replacing a key-value pair.
     * @param {string} key The primary key to associate the value with.
     * @param {*} value The value to write.
     * @param {*} [oldValue] The old value associated with the key to update the indices (if applicable).
     * @protected
     */
    _put(key, value, oldValue) {
        this._removed.delete(key);
        this._modified.set(key, value);

        // Update indices.
        for (const index of this._indices.values()) {
            index.put(key, value, oldValue);
        }
    }

    /**
     * Removes the key-value pair of the given key from the object store.
     * @param {string} key The primary key to delete along with the associated object.
     * @returns {Promise} The promise resolves after writing to the current object store finished.
     */
    async remove(key) {
        if (this._state !== Transaction.STATE.OPEN) {
            throw new Error('Transaction already closed');
        }

        const oldValue = await this.get(key);
        // Only remove if it exists.
        if (oldValue !== undefined) {
            // Save for indices.
            if (!this._originalValues.has(key)) {
                this._originalValues.set(key, oldValue);
            }

            this._remove(key, oldValue);
        }
    }

    /**
     * Internal method for removing a key-value pair.
     * @param {string} key The primary key to delete along with the associated object.
     * @param {*} oldValue The old value associated with the key to update the indices.
     * @protected
     */
    _remove(key, oldValue) {
        this._removed.add(key);
        this._modified.delete(key);

        // Update indices.
        for (const index of this._indices.values()) {
            index.remove(key, oldValue);
        }
    }

    /**
     * Returns a promise of a set of keys fulfilling the given query.
     * If the optional query is not given, it returns all keys in the object store.
     * If the query is of type KeyRange, it returns all keys of the object store being within this range.
     * If the query is of type Query, it returns all keys fulfilling the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Set.<string>>} A promise of the set of keys relevant to the query.
     */
    async keys(query=null) {
        if (query !== null && query instanceof Query) {
            return query.keys(this);
        }
        let keys = new Set();
        if (!this._truncated) {
            keys = await this.__backend.keys(query);
        }
        keys = keys.difference(this._removed);
        for (const key of this._modified.keys()) {
            if (query === null || query.includes(key)) {
                keys.add(key);
            }
        }
        return keys;
    }

    /**
     * Returns a promise of an array of objects whose primary keys fulfill the given query.
     * If the optional query is not given, it returns all objects in the object store.
     * If the query is of type KeyRange, it returns all objects whose primary keys are within this range.
     * If the query is of type Query, it returns all objects whose primary keys fulfill the query.
     * @param {Query|KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<Array.<*>>} A promise of the array of objects relevant to the query.
     */
    async values(query=null) {
        if (query !== null && query instanceof Query) {
            return query.values(this);
        }
        const keys = await this.keys(query);
        const valuePromises = [];
        for (const key of keys) {
            valuePromises.push(this.get(key));
        }
        return Promise.all(valuePromises);
    }

    /**
     * Iterates over the keys in a given range and direction.
     * The callback is called for each primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(key:string):boolean} callback A predicate called for each key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    async keyStream(callback, ascending=true, query=null) {
        // TODO Optimize this sorting step.
        let keys = Array.from(this._modified.keys());
        if (query instanceof KeyRange) {
            keys = keys.filter(key => query.includes(key));
        }
        keys = keys.sort();

        let txIt = keys.iterator(ascending);
        if (!this._truncated) {
            let stopped = false;

            await this.__backend.keyStream(key => {
                // Iterate over TxKeys as long as they are smaller (ascending) or larger (descending).
                while (txIt.hasNext() && ((ascending && txIt.peek() < key) || (!ascending && txIt.peek() > key))) {
                    const currentTxKey = txIt.next();
                    if (!callback(currentTxKey)) {
                        // Do not continue iteration.
                        stopped = true;
                        return false;
                    }
                }
                // Special case: what if next key is identical (-> modified)?
                // Present modified version and continue.
                if (txIt.hasNext() && txIt.peek() === key) {
                    const currentTxKey = txIt.next();
                    if (!callback(currentTxKey)) {
                        // Do not continue iteration.
                        stopped = true;
                        return false;
                    }
                    return true;
                }
                // Then give key of the backend's key stream.
                // But only if it hasn't been removed (lazy operator prevents calling callback in this case).
                if (!this._removed.has(key) && !callback(key)) {
                    // Do not continue iteration.
                    stopped = true;
                    return false;
                }
                return true;
            }, ascending, query);

            // Do not continue, if already stopped.
            if (stopped) {
                return;
            }
        }

        // Iterate over the remaining TxKeys.
        while (txIt.hasNext()) {
            if (!callback(txIt.next())) {
                break;
            }
        }
    }

    /**
     * Iterates over the keys and values in a given range and direction.
     * The callback is called for each value and primary key fulfilling the query
     * until it returns false and stops the iteration.
     * @param {function(value:*, key:string):boolean} callback A predicate called for each value and key until returning false.
     * @param {boolean} ascending Determines the direction of traversal.
     * @param {KeyRange} query An optional KeyRange to narrow down the iteration space.
     * @returns {Promise} The promise resolves after all elements have been streamed.
     */
    async valueStream(callback, ascending=true, query=null) {
        // TODO Optimize this sorting step.
        let keys = Array.from(this._modified.keys());
        if (query instanceof KeyRange) {
            keys = keys.filter(key => query.includes(key));
        }
        keys = keys.sort();

        let txIt = keys.iterator(ascending);
        if (!this._truncated) {
            let stopped = false;

            await this.__backend.valueStream((value, key) => {
                // Iterate over TxKeys as long as they are smaller (ascending) or larger (descending).
                while (txIt.hasNext() && ((ascending && txIt.peek() < key) || (!ascending && txIt.peek() > key))) {
                    const currentTxKey = txIt.next();
                    const value = this._modified.get(currentTxKey);
                    if (!callback(value, currentTxKey)) {
                        // Do not continue iteration.
                        stopped = true;
                        return false;
                    }
                }
                // Special case: what if next key is identical (-> modified)?
                // Present modified version and continue.
                if (txIt.hasNext() && txIt.peek() === key) {
                    const currentTxKey = txIt.next();
                    const value = this._modified.get(currentTxKey);
                    if (!callback(value, currentTxKey)) {
                        // Do not continue iteration.
                        stopped = true;
                        return false;
                    }
                    return true;
                }
                // Then give key of the backend's key stream.
                // But only if it hasn't been removed (lazy operator prevents calling callback in this case).
                if (!this._removed.has(key) && !callback(value, key)) {
                    // Do not continue iteration.
                    stopped = true;
                    return false;
                }
                return true;
            }, ascending, query);

            // Do not continue, if already stopped.
            if (stopped) {
                return;
            }
        }

        // Iterate over the remaining TxKeys.
        while (txIt.hasNext()) {
            const key = txIt.next();
            const value = await this.get(key);
            if (!callback(value, key)) {
                break;
            }
        }
    }

    /**
     * Returns a promise of the object whose primary key is maximal for the given range.
     * If the optional query is not given, it returns the object whose key is maximal.
     * If the query is of type KeyRange, it returns the object whose primary key is maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    async maxValue(query=null) {
        const maxKey = await this.maxKey(query);
        return this.get(maxKey);
    }

    /**
     * Returns a promise of the key being maximal for the given range.
     * If the optional query is not given, it returns the maximal key.
     * If the query is of type KeyRange, it returns the key being maximal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    async maxKey(query=null) {
        // Take underlying maxKey.
        let maxKey = undefined;
        if (!this._truncated) {
            maxKey = await this.__backend.maxKey(query);
        }

        // If this key has been removed, find next best key.
        while (maxKey !== undefined && this._removed.has(maxKey)) {
            const tmpQuery = KeyRange.upperBound(maxKey, true);
            maxKey = await this.__backend.maxKey(tmpQuery);

            // If we get out of the range, stop here.
            if (query !== null && !query.includes(maxKey)) {
                maxKey = undefined;
                break;
            }
        }

        for (const key of this._modified.keys()) {
            // Find better maxKey in modified data.
            if ((query === null || query.includes(key)) && (maxKey === undefined || key > maxKey)) {
                maxKey = key;
            }
        }
        return maxKey;
    }

    /**
     * Returns a promise of the object whose primary key is minimal for the given range.
     * If the optional query is not given, it returns the object whose key is minimal.
     * If the query is of type KeyRange, it returns the object whose primary key is minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<*>} A promise of the object relevant to the query.
     */
    async minValue(query=null) {
        const minKey = await this.minKey(query);
        return this.get(minKey);
    }

    /**
     * Returns a promise of the key being minimal for the given range.
     * If the optional query is not given, it returns the minimal key.
     * If the query is of type KeyRange, it returns the key being minimal for the given range.
     * @param {KeyRange} [query] Optional query to check keys against.
     * @returns {Promise.<string>} A promise of the key relevant to the query.
     */
    async minKey(query=null) {
        // Take underlying minKey.
        let minKey = undefined;
        if (!this._truncated) {
            minKey = await this.__backend.minKey(query);
        }

        // If this key has been removed, find next best key.
        while (minKey !== undefined && this._removed.has(minKey)) {
            const tmpQuery = KeyRange.lowerBound(minKey, true);
            minKey = await this.__backend.minKey(tmpQuery);

            // If we get out of the range, stop here.
            if (query !== null && !query.includes(minKey)) {
                minKey = undefined;
                break;
            }
        }

        for (const key of this._modified.keys()) {
            // Find better maxKey in modified data.
            if ((query === null || query.includes(key)) && (minKey === undefined || key < minKey)) {
                minKey = key;
            }
        }
        return minKey;
    }


    /**
     * Returns the count of entries in the given range.
     * If the optional query is not given, it returns the count of entries in the object store.
     * If the query is of type KeyRange, it returns the count of entries within the given range.
     * @param {KeyRange} [query]
     * @returns {Promise.<number>}
     */
    async count(query=null) {
        // Unfortunately, we cannot do better than getting keys + counting.
        return (await this.keys(query)).size;
    }

    /**
     * Returns the index of the given name.
     * If the index does not exist, it returns undefined.
     * @param {string} indexName The name of the requested index.
     * @returns {IIndex} The index associated with the given name.
     */
    index(indexName) {
        return this._indices.get(indexName);
    }

    /**
     * This method is not implemented for transactions.
     */
    createIndex() {
        throw new Error('Cannot create index in transaction');
    }

    /**
     * This method is not implemented for transactions.
     */
    async deleteIndex() {
        throw new Error('Cannot delete index in transaction');
    }

    /**
     * Alias for abort.
     * @returns {Promise} The promise resolves after successful abortion of the transaction.
     */
    close() {
        return this.abort();
    }

    /**
     * Creates a nested transaction, ensuring read isolation.
     * This makes the current transaction read-only until all sub-transactions have been closed (committed/aborted).
     * The same semantic for commits applies: Only the first transaction that commits will be applied. Subsequent transactions will be conflicted.
     * This behaviour has one exception: If all nested transactions are closed, the outer transaction returns to a normal state and new nested transactions can again be created and committed.
     * @param {boolean} [enableWatchdog]
     * @returns {Transaction} The transaction object.
     */
    transaction(enableWatchdog = true) {
        if (this._state !== Transaction.STATE.OPEN && this._state !== Transaction.STATE.NESTED) {
            throw new Error('Transaction already closed');
        }
        const tx = new Transaction(this._objectStore, this, this, enableWatchdog);
        this._nested.add(tx);
        this._state = Transaction.STATE.NESTED;
        return tx;
    }

    /**
     * Creates an in-memory snapshot of this state.
     * This snapshot only maintains the differences between the state at the time of the snapshot
     * and the current state.
     * To stop maintaining the snapshot, it has to be aborted.
     * @returns {Snapshot}
     */
    snapshot() {
        if (this.state !== Transaction.STATE.COMMITTED) {
            const snapshot = this._managingBackend.snapshot();
            snapshot.inherit(this);
            return snapshot;
        }
        return this._snapshotManager.createSnapshot(this._objectStore, this);
    }

    toString() {
        return `Transaction{id=${this._id}, changes=±${this._modified.size+this._removed.size}, truncated=${this._truncated}, objectStore=${this._objectStore}, state=${this._state}, dependency=${this._dependency}}`;
    }

    toStringShort() {
        return `Transaction{id=${this._id}, changes=±${this._modified.size+this._removed.size}, truncated=${this._truncated}, state=${this._state}, dependency=${this._dependency}}`;
    }
}
/** @type {number} Milliseconds to wait until automatically aborting transaction. */
Transaction.WATCHDOG_TIMER = 5000 /*ms*/;
/**
 * The states of a transaction.
 * New transactions are in the state OPEN until they are aborted, committed or a nested transaction is created.
 * Aborted transactions move to the state ABORTED.
 * Committed transactions move to the state COMMITTED,
 * if no other transaction has been applied to the same state.
 * Otherwise, they change their state to CONFLICTED.
 * When creating a nested (not read-isolated) transaction on top of a transaction,
 * the outer transaction moves to the state NESTED until the inner transaction is either aborted or committed.
 * Again, only one inner transaction may be committed.
 * @enum {number}
 */
Transaction.STATE = {
    OPEN: 0,
    COMMITTED: 1,
    ABORTED: 2,
    CONFLICTED: 3,
    NESTED: 4
};
Transaction._instanceCount = 0;
Class.register(Transaction);

/**
 * Snapshots present a read-only version of a specific state.
 * As long as a snapshot is not aborted, the object store will reflect changes to the state
 * in form of the differences to the originating state in the snapshot.
 * This makes efficient queries against a fixed state possible without blocking other transactions
 * to commit.
 * @extends {Transaction}
 */
class Snapshot extends Transaction {
    /**
     * This constructor should only be called by an ObjectStore object.
     * @param {ObjectStore} objectStore The object store this transaction belongs to.
     * @param {IObjectStore} backend The backend this transaction is based on.
     * @protected
     */
    constructor(objectStore, backend) {
        super(objectStore, backend, objectStore, false);
    }

    /**
     * A specific set of changes can be assumed to be already applied by providing a Transaction or Snapshot.
     * These differences will be inherited while the backend of the snapshot remains the current state.
     * This is useful, if we have a transaction/snapshot to a previous state, which we do not want to commit.
     * Then, we can still base our snapshot on this earlier state although the current backend is already ahead.
     * @param {Transaction} tx A transaction or snapshot containing changes that have already been applied.
     * @protected
     */
    inherit(tx) {
        if (!(tx instanceof Transaction)) {
            throw new Error('Can only inherit transactions');
        }

        return super._applySync(tx);
    }

    /**
     * Internally applies a transaction to the snapshot state.
     * In contrast to transactions, this tries to reflect the old state in the snapshot.
     * @param {Transaction} tx The transaction to apply.
     * @returns {Promise} The promise resolves after applying the transaction.
     * @protected
     */
    async _apply(tx) {
        if (!(tx instanceof Transaction)) {
            throw new Error('Can only apply transactions');
        }
        if (tx._truncated) {
            // Need to copy complete old state.
            await this.valueStream((value, key) => {
                if (!this._modified.has(key)) {
                    this._put(key, value);
                }
                return true;
            });
        }
        for (const [key, value] of tx._modified) {
            // Continue if we already have the old value for this key.
            if (this._modified.has(key)) {
                continue;
            }
            let oldValue = tx._originalValues.get(key);
            // If this key is newly introduced,
            // we have to mark it as removed to maintain our state.
            if (!oldValue) {
                this._remove(key, value);
            } else {
                // Otherwise store oldValue.
                this._put(key, oldValue, value);
            }
        }
        for (const key of tx._removed) {
            // Continue if we already have the old value for this key.
            if (this._modified.has(key)) {
                continue;
            }
            // Removed values have to be remembered.
            this._put(key, tx._originalValues.get(key));
        }
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     */
    async truncate() {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     * @throws
     */
    async commit(tx) {
        throw new Error('Cannot commit snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     * @protected
     * @param {Transaction} [tx] The transaction to be applied, if not given checks for the this transaction.
     * @returns {boolean} Whether a commit will be successful.
     */
    _isCommittable(tx) {
        return false;
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     * @protected
     * @param {Transaction} tx The transaction to be applied.
     * @returns {Promise} A promise that resolves upon successful application of the transaction.
     */
    async _commitInternal(tx) {
        throw new Error('Cannot commit snapshots');
    }

    /**
     * Commits the transaction to the backend.
     * @override
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @protected
     */
    async _commitBackend() {
        throw new Error('Cannot commit snapshots');
    }

    /**
     * Aborts a snapshot and stops updating its diff.
     * @override
     * @param [tx]
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    abort(tx) {
        return this._abortBackend();
    }

    /**
     * Aborts a transaction on the backend.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @override
     */
    async _abortBackend() {
        if (this._state !== Transaction.STATE.OPEN) {
            throw new Error('Snapshot already closed');
        }
        const result = await this._managingBackend.abort(this);
        if (!result) {
            return false;
        }

        this._state = Transaction.STATE.ABORTED;

        // Cleanup.
        this._truncated = true;
        this._modified.clear();
        this._removed.clear();
        this._originalValues.clear();

        // Update indices.
        for (const index of this._indices.values()) {
            index.truncate();
        }

        return true;
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     * @returns {Promise}
     */
    async put(key, value) {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     * @returns {Promise}
     */
    async remove(key) {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     */
    createIndex() {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     */
    async deleteIndex() {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Alias for abort.
     * @returns {Promise} The promise resolves after successful abortion of the transaction.
     */
    close() {
        return this.abort();
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     */
    transaction() {
        throw new Error('Unsupported operation on snapshots');
    }

    /**
     * Unsupported operation for snapshots.
     * @override
     */
    snapshot() {
        throw new Error('Unsupported operation on snapshots');
    }
}
Class.register(Snapshot);

/**
 * Defines the functionality needed for handling snapshots.
 * @abstract
 */
class SnapshotManager {
    constructor() {
        this._snapshots = new Set();
    }

    /**
     * Creates an in-memory snapshot of the current state.
     * This snapshot only maintains the differences between the state at the time of the snapshot
     * and the current state.
     * To stop maintaining the snapshot, it has to be aborted.
     * @param {ObjectStore} objectStore
     * @param {IObjectStore} backend
     * @returns {Snapshot}
     */
    createSnapshot(objectStore, backend) {
        const snapshot = new Snapshot(objectStore, backend);
        this._snapshots.add(snapshot);
        return snapshot;
    }


    /**
     * Aborts a snapshot.
     * @param {Snapshot} snapshot
     * @returns {boolean} A promise of the success outcome.
     */
    abortSnapshot(snapshot) {
        return this._snapshots.delete(snapshot);
    }

    /**
     * Updates the snapshots managed by this class.
     * @param {Transaction} tx The transaction to apply.
     * @param {IObjectStore} backend
     * @returns {Promise} The promise resolves after applying the transaction.
     */
    async applyTx(tx, backend) {
        if (!(tx instanceof Transaction)) {
            throw new Error('Can only apply transactions');
        }

        // First handle snapshots:
        // - Apply tx to own snapshots.
        // - Take over new snapshots.
        const applications = [];
        for (const snapshot of this._snapshots) {
            applications.push(snapshot._apply(tx));
        }
        for (const snapshot of tx._snapshotManager) {
            snapshot._backend = backend;
            this._snapshots.add(snapshot);
        }
        return Promise.all(applications);
    }

    /**
     * Returns an iterator over the snapshots.
     * @returns {Iterator.<Snapshot>}
     */
    [Symbol.iterator]() {
        return this._snapshots.values();
    }
}
Class.register(SnapshotManager);

/**
 * This class represents a combined transaction across object stores.
 * @implements {ICommittable}
 */
class CombinedTransaction {
    /**
     * @param {...Transaction} transactions The transactions to build the combined transaction from.
     */
    constructor(...transactions) {
        if (!this.isConsistent(transactions)) {
            throw new Error('Given set of transactions violates rules for combined transactions');
        }
        this._transactions = transactions;
        /** @type {Map.<Transaction,function()>} */
        this._flushable = new Map();
        /** @type {Map.<Transaction,function()>} */
        this._preprocessing = [];

        // Update members.
        this._dependency = this;
    }

    /** @type {JungleDB} */
    get backend() {
        return this._jdb;
    }

    /** @type {Array.<Transaction>} */
    get transactions() {
        return this._transactions;
    }

    /**
     * Verifies the two most important consistency rules for combined transactions:
     * 1. only transactions from different object stores
     * 2. only open transactions
     * 3. only transactions from the same JungleDB instance
     * 4. only non-nested transactions
     * @param {Array.<Transaction>} transactions
     * @returns {boolean} Whether the given set of transactions is suitable for a combined transaction.
     */
    isConsistent(transactions) {
        const objectStores = new Set();
        this._jdb = null;
        for (const tx of transactions) {
            // Rule 2 is violated:
            if (tx.state !== Transaction.STATE.OPEN) {
                return false;
            }
            // Rule 4 is violated:
            if (tx.nested) {
                return false;
            }
            // Rule 1 is violated:
            if (objectStores.has(tx._objectStore)) {
                return false;
            }
            // Rule 3 is violated:
            if (this._jdb === null) {
                this._jdb = tx._objectStore.jungleDB;
            } else if (this._jdb !== tx._objectStore.jungleDB && tx._objectStore.jungleDB !== null) { // null = InMemory
                return false;
            }
            objectStores.add(tx._objectStore);
        }
        return true;
    }

    /**
     * To be called when a transaction is flushable to the persistent state.
     * Triggers combined flush as soon as all transactions are ready.
     * @param {Transaction} tx Transaction to be reported flushable.
     * @param {function()} [callback] A callback to be called after the transaction is flushed.
     * @param {function():Promise} [preprocessing] A callback to be called right before the transaction is flushed.
     * @returns {Promise.<boolean>} Whether the flushing has been triggered.
     */
    async onFlushable(tx, callback=null, preprocessing=null) {
        // Save as flushable and prepare and flush only if all are flushable.
        // Afterwards call the callbacks to cleanup the ObjectStores' transaction stacks.
        this._flushable.set(tx, callback);
        if (preprocessing !== null) {
            this._preprocessing.push(preprocessing);
        }

        // All are flushable, so go ahead.
        if (this._transactions.every(tx => this._flushable.has(tx))) {
            // Allow to prepare final flush.
            const preprocessings = [];
            for (const f of this._preprocessing) {
                preprocessings.push(f());
            }
            await Promise.all(preprocessings);

            await JungleDB.commitCombined(this);
            for (const value of this._flushable.values()) {
                value();
            }
            return true;
        }
        return false;
    }

    /**
     * Is used to commit the state of an open transaction.
     * A user only needs to call this method on Transactions without arguments.
     * The optional tx argument is only used internally, in order to commit a transaction to the underlying store.
     * If the commit was successful, the method returns true, and false otherwise.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     */
    async commit() {
        if (this._isCommittable()) {
            await this._commitBackend();
            return true;
        }
        await this.abort();
        return false;
    }

    /**
     * Is used to abort an open transaction.
     * A user only needs to call this method on Transactions without arguments.
     * The optional tx argument is only used internally, in order to abort a transaction on the underlying store.
     * @returns {Promise} The promise resolves after successful abortion of the transaction.
     */
    abort() {
        return this._abortBackend();
    }

    /**
     * Aborts a transaction on the backend.
     * @returns {Promise.<boolean>} A promise of the success outcome.
     * @override
     */
    async _abortBackend() {
        return (await Promise.all(this._transactions.map(tx => tx._abortBackend()))).every(r => r);
    }

    /**
     * Creates a new transaction, ensuring read isolation
     * on the most recently successfully committed state.
     * @param {boolean} [enableWatchdog]
     * @returns {Transaction} The transaction object.
     */
    transaction(enableWatchdog) {
        throw new Error('Unsupported operation');
    }

    /**
     * Creates an in-memory snapshot of the current state.
     * This snapshot only maintains the differences between the state at the time of the snapshot
     * and the current state.
     * To stop maintaining the snapshot, it has to be aborted.
     * @returns {Snapshot}
     */
    snapshot() {
        throw new Error('Unsupported operation');
    }

    /**
     * Is used to probe whether a transaction can be committed.
     * This, for example, includes a check whether another transaction has already been committed.
     * @protected
     * @returns {boolean} Whether a commit will be successful.
     */
    _isCommittable() {
        return this._transactions.every(tx => tx._isCommittable());
    }

    /**
     * Is used to commit the transaction.
     * @protected
     * @returns {Promise} A promise that resolves upon successful application of the transaction.
     */
    async _commitBackend() {
        return (await Promise.all(this._transactions.map(tx => tx._commitBackend()))).every(r => r);
    }

    /**
     * Unsupported operation for snapshots.
     * @protected
     * @param {Transaction} tx The transaction to be applied.
     * @returns {Promise} A promise that resolves upon successful application of the transaction.
     */
    async _commitInternal(tx) {
        throw new Error('Cannot commit transactions to a combined transaction');
    }

    /**
     * Allows to change the backend of a Transaction when the state has been flushed.
     * @param backend
     * @protected
     */
    set _backend(backend) {
        throw new Error('Unsupported operation');
    }

    /**
     * Sets a new CombinedTransaction as dependency.
     * @param {CombinedTransaction} dependency
     * @protected
     */
    set _dependency(dependency) {
        for (const tx of this._transactions) {
            tx._dependency = dependency;
        }
    }

    /**
     * @type {CombinedTransaction} If existent, a combined transaction encompassing this object.
     */
    get dependency() {
        return this;
    }

    /**
     * Returns the object store this transaction belongs to.
     * @type {ObjectStore}
     */
    get objectStore() {
        throw new Error('Unsupported operation');
    }

    toString() {
        return `CombinedTransaction{size=${this._transactions.length}, states=[${this._transactions.map(tx => tx.state)}]}`;
    }
}
Class.register(CombinedTransaction);

    exports._loaded = true;
    if (typeof exports._onload === 'function') exports._onload();
    return exports;
})(JDB);



if (typeof Nimiq === 'undefined') {
    var Nimiq = typeof window !== 'undefined' ? window : {};
}
var Proxy; // ensure Proxy exists
(function (exports) {
    exports = typeof exports !== 'undefined' ? exports : {};
    Nimiq = exports;
    if (!Nimiq._currentScript) {
        Nimiq._currentScript = document.currentScript;
    }
    if (!Nimiq._currentScript) {
        // Heuristic
        const scripts = document.getElementsByTagName('script');
        Nimiq._currentScript = scripts[scripts.length - 1];
    }
    if (!Nimiq._path) {
        if (Nimiq._currentScript && Nimiq._currentScript.src.indexOf('/') !== -1) {
            Nimiq._path = Nimiq._currentScript.src.substring(0, Nimiq._currentScript.src.lastIndexOf('/') + 1);
        } else {
            // Fallback
            Nimiq._path = './';
        }
    }

class Class {
    static register(cls) {
        if (typeof exports !== 'undefined') exports[cls.name] = cls;
    }
}
Class.register(Class);

class LogNative {
    constructor() {
        this._global_level = Log.INFO;
        this._tag_levels = {};
        try {
            if (window.localStorage) {
                try {
                    let c = window.localStorage.getItem('log_tag_levels');
                    if (c && typeof c === 'string') c = JSON.parse(c);
                    if (c && typeof c === 'object') this._tag_levels = c;
                } catch (e) {
                    console.warn('Failed to load log configuration from local storage.');
                }
            }
        } catch (e) {
            // ignore
        }
    }

    isLoggable(tag, level) {
        if (tag && this._tag_levels[tag]) {
            return this._tag_levels[tag] <= level;
        }
        if (this._tag_levels['*']) {
            return this._tag_levels['*'] <= level;
        }
        return this._global_level <= level;
    }

    setLoggable(tag, level) {
        if (tag && tag.name) tag = tag.name;
        this._tag_levels[tag] = level;
        if (window.localStorage) {
            window.localStorage.setItem('log_tag_levels', JSON.stringify(this._tag_levels));
        }
    }

    msg(level, tag, args) {
        if (tag && tag.name) tag = tag.name;
        if (!this.isLoggable(tag, level)) return;
        if (tag) args.unshift(tag + ':');
        args.unshift(`[${Log.Level.toStringTag(level)} ${new Date().toTimeString().substr(0, 8)}]`);
        if (console.error && level >= Log.ERROR) {
            console.error.apply(console, args);
        } else if (console.warn && level >= Log.WARNING) {
            console.warn.apply(console, args);
        } else if (console.info && level >= Log.INFO) {
            console.info.apply(console, args);
        } else if (console.debug && level >= Log.DEBUG) {
            console.debug.apply(console, args);
        } else if (console.trace && level <= Log.TRACE) {
            console.trace.apply(console, args);
        } else {
            console.log.apply(console, args);
        }
    }
}
Class.register(LogNative);

class Log {
    /**
     * @returns {Log}
     */
    static get instance() {
        if (!Log._instance) {
            Log._instance = new Log(new LogNative());
        }
        return Log._instance;
    }

    /**
     * @param {LogNative} native
     */
    constructor(native) {
        /** @type {LogNative} */
        this._native = native;
    }

    /**
     * @param {string} tag
     * @param {Log.Level} level
     */
    setLoggable(tag, level) {
        this._native.setLoggable(tag, level);
    }

    /** @type {Log.Level} */
    get level() {
        return this._native._global_level;
    }

    /** @type {Log.Level} */
    set level(l) {
        this._native._global_level = l;
    }

    /**
     * @param {Log.Level} level
     * @param {string|{name:string}} tag
     * @param {Array} args
     */
    msg(level, tag, args) {
        if (this._native.isLoggable(tag, level)) {
            for (let i = 0; i < args.length; ++i) {
                if (typeof args[i] === 'function') {
                    args[i] = args[i]();
                }
                if (typeof args[i] === 'object') {
                    if (typeof args[i].toString === 'function') {
                        args[i] = args[i].toString();
                    } else if (args[i].constructor && args[i].constructor.name) {
                        args[i] = `{Object: ${args[i].constructor.name}}`;
                    } else {
                        args[i] = '{Object}';
                    }
                }
            }
            this._native.msg(level, tag, args);
        }
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static d(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.DEBUG, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static e(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.ERROR, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static i(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.INFO, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static v(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.VERBOSE, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static w(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.WARNING, tag, args);
    }

    /**
     * @param {?string|{name:string}} [tag=undefined]
     * @param {string|function():string} message
     * @param {...*} args
     */
    static t(tag, message, ...args) {
        if (arguments.length >= 2) {
            tag = arguments[0];
            args = Array.prototype.slice.call(arguments, 1);
        } else {
            tag = undefined;
            args = Array.prototype.slice.call(arguments, 0);
        }
        Log.instance.msg(Log.TRACE, tag, args);
    }
}
/**
 * @enum {number}
 */
Log.Level = {
    TRACE: 1,
    VERBOSE: 2,
    DEBUG: 3,
    INFO: 4,
    WARNING: 5,
    ERROR: 6,
    ASSERT: 7,

    /**
     * @param {Log.Level} level
     */
    toStringTag: function (level) {
        switch (level) {
            case Log.TRACE:
                return 'T';
            case Log.VERBOSE:
                return 'V';
            case Log.DEBUG:
                return 'D';
            case Log.INFO:
                return 'I';
            case Log.WARNING:
                return 'W';
            case Log.ERROR:
                return 'E';
            case Log.ASSERT:
                return 'A';
            default:
                return '*';
        }
    }
};
Log.TRACE = Log.Level.TRACE;
Log.VERBOSE = Log.Level.VERBOSE;
Log.DEBUG = Log.Level.DEBUG;
Log.INFO = Log.Level.INFO;
Log.WARNING = Log.Level.WARNING;
Log.ERROR = Log.Level.ERROR;
Log.ASSERT = Log.Level.ASSERT;
Log._instance = null;
Class.register(Log);

class Observable {
    /**
     * @returns {string}
     * @constant
     */
    static get WILDCARD() {
        return '*';
    }

    constructor() {
        /** @type {Map.<string, Array.<Function>>} */
        this._listeners = new Map();
    }

    /**
     * @param {string} type
     * @param {Function} callback
     * @return {number}
     */
    on(type, callback) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, [callback]);
            return 0;
        } else {
            return this._listeners.get(type).push(callback) - 1;
        }
    }

    /**
     * @param {string} type
     * @param {number} id
     */
    off(type, id) {
        if (!this._listeners.has(type) || !this._listeners.get(type)[id]) return;
        delete this._listeners.get(type)[id];
    }

    /**
     * @param {string} type
     * @param {...*} args
     */
    fire(type, ...args) {
        // Notify listeners for this event type.
        if (this._listeners.has(type)) {
            for (const i in this._listeners.get(type)) {
                const listener = this._listeners.get(type)[i];
                listener.apply(null, args);
            }
        }

        // Notify wildcard listeners. Pass event type as first argument
        if (this._listeners.has(Observable.WILDCARD)) {
            for (const i in this._listeners.get(Observable.WILDCARD)) {
                const listener = this._listeners.get(Observable.WILDCARD)[i];
                listener.apply(null, arguments);
            }
        }
    }

    /**
     * @param {Observable} observable
     * @param {...string} types
     */
    bubble(observable, ...types) {
        for (const type of types) {
            let callback;
            if (type == Observable.WILDCARD) {
                callback = function() {
                    this.fire.apply(this, arguments);
                };
            } else {
                callback = function() {
                    this.fire.apply(this, [type, ...arguments]);
                };
            }
            observable.on(type, callback.bind(this));
        }
    }
}
Class.register(Observable);

class CryptoLib {
    /**
     * @return {SubtleCrypto|*}
     */
    static get instance() {
        if (!CryptoLib._instance) {
            const instance = {};
            instance.getRandomValues = (window.crypto || window.msCrypto).getRandomValues.bind(window.crypto);

            CryptoLib._instance = instance;
        }
        return CryptoLib._instance;
    }
}
CryptoLib._instance = null;
Class.register(CryptoLib);

class NetworkConfig {
    static myPeerAddress() {
        if (!PlatformUtils.supportsWebRTC()) {
            return new DumbPeerAddress(
                Services.myServices(), Time.now(), NetAddress.UNSPECIFIED,
                /*id*/ NumberUtils.randomUint64());
        }

        if (!NetworkConfig._mySignalId) {
            throw 'PeerAddress is not configured';
        }

        return new RtcPeerAddress(
            Services.myServices(), Time.now(), NetAddress.UNSPECIFIED,
            NetworkConfig._mySignalId, /*distance*/ 0);
    }

    // Used for filtering peer addresses by protocols.
    static myProtocolMask() {
        return Protocol.WS | Protocol.RTC;
    }

    static canConnect(protocol) {
        switch (protocol) {
            case Protocol.WS:
                return true;
            case Protocol.RTC:
                return PlatformUtils.supportsWebRTC();
            case Protocol.DUMB:
            default:
                return false;
        }
    }

    static configurePeerAddress(signalId) {
        NetworkConfig._mySignalId = signalId;
    }
}
Class.register(NetworkConfig);

class WebRtcStore {
    /**
     * @returns {Promise.<WalletStore>}
     */
    constructor() {
        this._jdb = new JDB.JungleDB('webrtc', WebRtcStore.VERSION);
        return this._init();
    }

    /**
     * @returns {Promise.<WalletStore>}
     * @private
     */
    async _init() {
        // Initialize object stores.
        this._jdb.createObjectStore(WebRtcStore.KEY_DATABASE, new WebRtcStoreCodec());

        // Establish connection to database.
        await this._jdb.connect();

        return this;
    }

    /**
     * @param {string} key
     * @returns {Promise.<KeyPair>}
     */
    get(key) {
        const store = this._jdb.getObjectStore(WebRtcStore.KEY_DATABASE);
        return store.get(key);
    }

    /**
     * @param {string} key
     * @param {KeyPair} keyPair
     * @returns {Promise}
     */
    put(key, keyPair) {
        const store = this._jdb.getObjectStore(WebRtcStore.KEY_DATABASE);
        return store.put(key, keyPair);
    }

    close() {
        return this._jdb.close();
    }
}
WebRtcStore._instance = null;
WebRtcStore.VERSION = 2;
WebRtcStore.KEY_DATABASE = 'keys';
Class.register(WebRtcStore);

/**
 * @implements {ICodec}
 */
class WebRtcStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return obj.serialize();
    }

    /**
     * @param {*} buf The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(buf, key) {
        return KeyPair.unserialize(new SerialBuffer(buf));
    }

    /**
     * @type {string}
     */
    get valueEncoding() {
        return 'binary';
    }
}

class WebRtcConfig {
    static async get() {
        // Initialize singleton.
        if (!WebRtcConfig._config) {
            // If browser does not support WebRTC, simply return empty config.
            if (!PlatformUtils.supportsWebRTC()) {
                WebRtcConfig._config = {};
                return WebRtcConfig._config;
            }

            WebRtcConfig._config = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun.nimiq-network.com:19302' }
                ]
            };

            // Configure our peer address.
            const signalId = await WebRtcConfig.mySignalId();
            NetworkConfig.configurePeerAddress(signalId);
        }

        return WebRtcConfig._config;
    }

    /**
     * @returns {Promise.<KeyPair>}
     */
    static async myKeyPair() {
        if (!WebRtcConfig._keyPair) {
            const db = await new WebRtcStore();
            let keys = await db.get('keys');
            if (!keys) {
                keys = await KeyPair.generate();
                await db.put('keys', keys);
            }
            await db.close();
            WebRtcConfig._keyPair = keys;
        }
        return WebRtcConfig._keyPair;
    }

    /**
     * @returns {Promise.<SignalId>}
     */
    static async mySignalId() {
        const keyPair = await WebRtcConfig.myKeyPair();
        return keyPair.publicKey.toSignalId();
    }
}
Class.register(WebRtcConfig);

class WebRtcDataChannel extends Observable {
    constructor(nativeChannel) {
        super();
        // We expect WebRtc data channels to be ordered.
        Assert.that(nativeChannel.ordered, 'WebRtc data channel not ordered');
        this._channel = nativeChannel;

        this._channel.onmessage = msg => this._onMessage(msg.data || msg);
        this._channel.onclose = () => this.fire('close', this);
        this._channel.onerror = e => this.fire('error', e, this);

        // Buffer for chunked messages.
        // XXX We currently only support one chunked message at a time.
        this._buffer = null;

        this._timers = new Timers();
    }

    _onMessage(msg) {
        // XXX Convert Blob to ArrayBuffer if necessary.
        // TODO FileReader is slow and this is ugly anyways. Improve!
        if (msg instanceof Blob) {
            const reader = new FileReader();
            reader.onloadend = () => this._onMessage(reader.result);
            reader.readAsArrayBuffer(msg);
            return;
        }

        // Blindly forward empty messages.
        // TODO should we drop them instead?
        const buffer = new SerialBuffer(msg);
        if (buffer.byteLength === 0) {
            Log.w(WebRtcDataChannel, 'Received empty message', buffer, msg);
            this.fire('message', msg, this);
            return;
        }

        // Detect if this is a chunked message.
        switch (buffer.readUint8()) {
            case WebRtcDataChannel.CHUNK_BEGIN_MAGIC: {
                if (this._buffer !== null) {
                    Log.e(WebRtcDataChannel, 'Received CHUNK_BEGIN while already receiving chunked message');
                }

                // Read & check the total message size.
                const messageSize = buffer.readUint32();
                if (messageSize > WebRtcDataChannel.MESSAGE_SIZE_MAX) {
                    Log.e(WebRtcDataChannel, `Received CHUNK_BEGIN with excessive message size ${messageSize} > ${WebRtcDataChannel.MESSAGE_SIZE_MAX}`);
                    return;
                }

                // Create a new SerialBuffer for the chunked message.
                this._buffer = new SerialBuffer(messageSize);

                // Read & store chunk.
                const chunk = buffer.read(buffer.byteLength - buffer.readPos);
                this._buffer.write(chunk);

                // Set timeout.
                this._timers.resetTimeout('chunk', this._onChunkTimeout.bind(this), WebRtcDataChannel.CHUNK_TIMEOUT);

                break;
            }

            case WebRtcDataChannel.CHUNK_INNER_MAGIC: {
                if (!this._buffer) {
                    Log.w(WebRtcDataChannel, 'Received CHUNK_INNER without preceding CHUNK_BEGIN, discarding');
                    return;
                }

                // Read & store chunk.
                const chunk = buffer.read(buffer.byteLength - buffer.readPos);
                this._buffer.write(chunk);

                // Reset timeout.
                this._timers.resetTimeout('chunk', this._onChunkTimeout.bind(this), WebRtcDataChannel.CHUNK_TIMEOUT);

                break;
            }

            case WebRtcDataChannel.CHUNK_END_MAGIC: {
                if (!this._buffer) {
                    Log.w(WebRtcDataChannel, 'Received CHUNK_END without preceding CHUNK_BEGIN, discarding');
                    return;
                }

                // Read & store chunk.
                const chunk = buffer.read(buffer.byteLength - buffer.readPos);
                this._buffer.write(chunk);

                // Clear timeout.
                this._timers.clearTimeout('chunk');

                // Check that we have received the full message.
                if (this._buffer.writePos !== this._buffer.byteLength) {
                    Log.e(WebRtcDataChannel, `Received incomplete chunked message (expected=${this._buffer.byteLength}, received=${this._buffer.writePos}), discarding`);
                    this._buffer = null;
                    return;
                }

                // Full message received, notify listeners and reset buffer.
                this.fire('message', this._buffer.buffer, this);
                this._buffer = null;

                break;
            }

            default:
                // Not a chunked message, notify listeners.
                this.fire('message', msg, this);
        }
    }

    _onChunkTimeout() {
        Log.e(WebRtcDataChannel, 'Timeout while receiving chunked message');
        this._buffer = null;
    }

    send(msg) {
        Assert.that(msg.byteLength <= WebRtcDataChannel.MESSAGE_SIZE_MAX, 'WebRtcDataChannel.send() max message size exceeded');

        if (msg.byteLength > WebRtcDataChannel.CHUNK_SIZE_MAX) {
            // We need to split the message into chunks.
            this._sendChunked(msg);
        } else {
            // The message fits within a chunk, send directly.
            this._channel.send(msg);
        }
    }

    _sendChunked(msg) {
        // Send first chunk.
        let buffer = new SerialBuffer(WebRtcDataChannel.CHUNK_SIZE_MAX);
        buffer.writeUint8(WebRtcDataChannel.CHUNK_BEGIN_MAGIC);
        buffer.writeUint32(msg.byteLength);
        let chunk = new Uint8Array(msg.buffer, 0, WebRtcDataChannel.CHUNK_SIZE_MAX - buffer.writePos);
        buffer.write(chunk);
        this._channel.send(buffer);

        // Send remaining chunks.
        let remaining = msg.byteLength - chunk.byteLength;
        while (remaining > 0) {
            if (remaining >= WebRtcDataChannel.CHUNK_SIZE_MAX) {
                buffer.reset();
                buffer.writeUint8(WebRtcDataChannel.CHUNK_INNER_MAGIC);
                chunk = new Uint8Array(msg.buffer, msg.byteLength - remaining, WebRtcDataChannel.CHUNK_SIZE_MAX - buffer.writePos);
            } else {
                buffer = new SerialBuffer(remaining + 1);
                buffer.writeUint8(WebRtcDataChannel.CHUNK_END_MAGIC);
                chunk = new Uint8Array(msg.buffer, msg.byteLength - remaining, remaining);
            }

            buffer.write(chunk);
            this._channel.send(buffer);
            remaining -= chunk.byteLength;
        }
    }

    close() {
        this._channel.close();
    }

    get readyState() {
        return this._channel.readyState;
    }
}
WebRtcDataChannel.CHUNK_SIZE_MAX = 1024 * 16; // 16 kb
WebRtcDataChannel.MESSAGE_SIZE_MAX = 10 * 1024 * 1024; // 10 mb
WebRtcDataChannel.CHUNK_TIMEOUT = 1000 * 5; // 5 seconds

// These must not overlap with the first byte of the Message magic.
WebRtcDataChannel.CHUNK_BEGIN_MAGIC = 0xff;
WebRtcDataChannel.CHUNK_INNER_MAGIC = 0xfe;
WebRtcDataChannel.CHUNK_END_MAGIC = 0xfd;
Class.register(WebRtcDataChannel);

class WebRtcUtils {
    static candidateToNetAddress(candidate) {
        // TODO XXX Ad-hoc parsing of candidates - Improve!
        const parts = candidate.candidate.split(' ');
        if (parts.length < 6) {
            return null;
        }
        return NetAddress.fromIP(parts[4]);
    }
}
Class.register(WebRtcUtils);

class WebRtcConnector extends Observable {
    constructor() {
        super();
        return this._init();
    }

    async _init() {
        /** @type {HashMap.<SignalId,PeerConnector>} */
        this._connectors = new HashMap();
        this._config = await WebRtcConfig.get();
        this._timers = new Timers();

        return this;
    }

    connect(peerAddress, signalChannel) {
        if (peerAddress.protocol !== Protocol.RTC) throw 'Malformed peerAddress';

        const signalId = peerAddress.signalId;
        if (this._connectors.contains(signalId)) {
            Log.w(WebRtcConnector, `WebRtc: Already connecting/connected to ${signalId}`);
            return false;
        }

        const connector = new OutboundPeerConnector(this._config, peerAddress, signalChannel);
        connector.on('connection', conn => this._onConnection(conn, signalId));
        this._connectors.put(signalId, connector);

        this._timers.setTimeout(`connect_${signalId}`, () => {
            this._connectors.remove(signalId);
            this._timers.clearTimeout(`connect_${signalId}`);
            this.fire('error', peerAddress, 'timeout');
        }, WebRtcConnector.CONNECT_TIMEOUT);

        return true;
    }

    isValidSignal(msg) {
        return this._connectors.contains(msg.senderId) && this._connectors.get(msg.senderId).nonce === msg.nonce;
    }

    onSignal(channel, msg) {
        // Check if we received an unroutable/ttl exceeded response from one of the signaling peers.
        if (msg.isUnroutable() || msg.isTtlExceeded()) {
            // Clear the timeout early if we initiated the connection.
            if (this.isValidSignal(msg) && this._connectors.get(msg.senderId) instanceof OutboundPeerConnector) {
                const peerAddress = this._connectors.get(msg.senderId).peerAddress;

                this._connectors.remove(msg.senderId);
                this._timers.clearTimeout(`connect_${msg.senderId}`);

                // XXX Reason needs to be adapted when more flags are added.
                const reason =  msg.isUnroutable() ? 'unroutable' : 'ttl exceeded';
                this.fire('error', peerAddress, reason);
            }

            return;
        }

        let payload;
        try {
            payload = JSON.parse(BufferUtils.toAscii(msg.payload));
        } catch (e) {
            Log.e(WebRtcConnector, `Failed to parse signal payload from ${msg.senderId}`);
            return;
        }

        if (!payload) {
            Log.d(WebRtcConnector, `Discarding signal from ${msg.senderId} - empty payload`);
            return;
        }

        if (payload.type === 'offer') {
            // Check if we have received an offer on an ongoing connection.
            // This can happen if two peers initiate connections to one another
            // simultaneously. Resolve this by having the peer with the higher
            // signalId discard the offer while the one with the lower signalId
            // accepts it.
            if (this._connectors.contains(msg.senderId)) {
                if (msg.recipientId.compare(msg.senderId) === 1) {
                    // Discard the offer.
                    Log.d(WebRtcConnector, `Simultaneous connection, discarding offer from ${msg.senderId} (<${msg.recipientId})`);
                    return;
                } else {
                    // We are going to accept the offer. Clear the connect timeout
                    // from our previous Outbound connection attempt to this peer.
                    Log.d(WebRtcConnector, `Simultaneous connection, accepting offer from ${msg.senderId} (>${msg.recipientId})`);
                    this._timers.clearTimeout(`connect_${msg.senderId}`);
                }
            }

            // Accept the offer.
            const connector = new InboundPeerConnector(this._config, channel, msg.senderId, payload);
            connector.on('connection', conn => this._onConnection(conn, msg.senderId));
            this._connectors.put(msg.senderId, connector);

            this._timers.setTimeout(`connect_${msg.senderId}`, () => {
                this._timers.clearTimeout(`connect_${msg.senderId}`);
                this._connectors.remove(msg.senderId);
            }, WebRtcConnector.CONNECT_TIMEOUT);
        }

        // If we are already establishing a connection with the sender of this
        // signal, forward it to the corresponding connector.
        else if (this._connectors.contains(msg.senderId)) {
            this._connectors.get(msg.senderId).onSignal(payload);
        }

        // If none of the above conditions is met, the signal is invalid and we discard it.
    }

    _onConnection(conn, signalId) {
        // Clear the connect timeout.
        this._timers.clearTimeout(`connect_${signalId}`);

        // Clean up when this connection closes.
        conn.on('close', () => this._onClose(signalId));

        // Tell listeners about the new connection.
        this.fire('connection', conn);
    }

    _onClose(signalId) {
        this._connectors.remove(signalId);
        this._timers.clearTimeout(`connect_${signalId}`);
    }
}
WebRtcConnector.CONNECT_TIMEOUT = 5000; // ms
Class.register(WebRtcConnector);

class PeerConnector extends Observable {
    constructor(config, signalChannel, signalId, peerAddress) {
        super();
        this._signalChannel = signalChannel;
        this._signalId = signalId;
        this._peerAddress = peerAddress; // null for inbound connections

        this._nonce = NumberUtils.randomUint32();

        this._rtcConnection = new RTCPeerConnection(config);
        this._rtcConnection.onicecandidate = e => this._onIceCandidate(e);

        this._lastIceCandidate = null;
        this._iceCandidateQueue = [];
    }

    onSignal(signal) {
        if (signal.sdp) {
            this._rtcConnection.setRemoteDescription(new RTCSessionDescription(signal))
                .then(() => {
                    if (signal.type === 'offer') {
                        this._rtcConnection.createAnswer()
                            .then(description => this._onDescription(description))
                            .catch(error => this._errorLog(error));
                    }

                    this._handleCandidateQueue();
                })
                .catch(error => this._errorLog(error));
        } else if (signal.candidate) {
            this._addIceCandidate(signal);
        }
    }

    /**
     * @param {*} signal
     * @returns {Promise}
     * @private
     */
    _addIceCandidate(signal) {
        this._lastIceCandidate = new RTCIceCandidate(signal);

        // Do not try to add ICE candidates before the remote description is set.
        if (!this._rtcConnection.remoteDescription || !this._rtcConnection.remoteDescription.type) {
            this._iceCandidateQueue.push(signal);
            return Promise.resolve();
        }

        return this._rtcConnection.addIceCandidate(this._lastIceCandidate)
            .catch(error => this._errorLog(error));
    }

    async _handleCandidateQueue() {
        // Handle ICE candidates if they already arrived.
        for (const candidate of this._iceCandidateQueue) {
            await this._addIceCandidate(candidate);
        }
        this._iceCandidateQueue = [];
    }

    async _signal(signal) {
        const payload = BufferUtils.fromAscii(JSON.stringify(signal));
        const keyPair = await WebRtcConfig.myKeyPair();
        this._signalChannel.signal(
            NetworkConfig.myPeerAddress().signalId,
            this._signalId,
            this._nonce,
            Network.SIGNAL_TTL_INITIAL,
            0, /*flags*/
            payload,
            keyPair.publicKey,
            await Signature.create(keyPair.privateKey, keyPair.publicKey, payload)
        );
    }

    _onIceCandidate(event) {
        if (event.candidate !== null) {
            this._signal(event.candidate);
        }
    }

    _onDescription(description) {
        this._rtcConnection.setLocalDescription(description)
            .then(() => this._signal(this._rtcConnection.localDescription))
            .catch(error => this._errorLog(error));
    }

    _onDataChannel(event) {
        const channel = new WebRtcDataChannel(event.channel || event.target);

        // There is no API to get the remote IP address. As a crude heuristic, we parse the IP address
        // from the last ICE candidate seen before the connection was established.
        // TODO Can we improve this?
        let netAddress = null;
        if (this._lastIceCandidate) {
            try {
                netAddress = WebRtcUtils.candidateToNetAddress(this._lastIceCandidate);
            } catch(e) {
                Log.w(PeerConnector, `Failed to parse IP from ICE candidate: ${this._lastIceCandidate}`);
            }
        } else {
            // XXX Why does this happen?
            Log.w(PeerConnector, 'No ICE candidate seen for inbound connection');
        }

        const conn = new PeerConnection(channel, Protocol.RTC, netAddress, this._peerAddress);
        this.fire('connection', conn);
    }

    _errorLog(error) {
        Log.e(PeerConnector, error);
    }

    get nonce() {
        return this._nonce;
    }

    get peerAddress() {
        return this._peerAddress;
    }
}
Class.register(PeerConnector);

class OutboundPeerConnector extends PeerConnector {
    constructor(config, peerAddress, signalChannel) {
        super(config, signalChannel, peerAddress.signalId, peerAddress);
        this._peerAddress = peerAddress;

        // Create offer.
        const channel = this._rtcConnection.createDataChannel('data-channel');
        channel.binaryType = 'arraybuffer';
        channel.onopen = e => this._onDataChannel(e);
        this._rtcConnection.createOffer()
            .then(description => this._onDescription(description))
            .catch(error => this._errorLog(error));
    }
}
Class.register(OutboundPeerConnector);

class InboundPeerConnector extends PeerConnector {
    constructor(config, signalChannel, signalId, offer) {
        super(config, signalChannel, signalId, null);
        this._rtcConnection.ondatachannel = event => {
            event.channel.onopen = e => this._onDataChannel(e);
        };
        this.onSignal(offer);
    }
}
Class.register(InboundPeerConnector);

class WebSocketConnector extends Observable {
    constructor() {
        super();
        this._timers = new Timers();
    }

    connect(peerAddress) {
        if (peerAddress.protocol !== Protocol.WS) throw 'Malformed peerAddress';

        const timeoutKey = `connect_${peerAddress}`;
        if (this._timers.timeoutExists(timeoutKey)) {
            Log.w(WebSocketConnector, `Already connecting to ${peerAddress}`);
            return false;
        }

        const ws = new WebSocket(`wss://${peerAddress.host}:${peerAddress.port}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            this._timers.clearTimeout(timeoutKey);

            // There is no way to determine the remote IP ... thanks for nothing, WebSocket API.
            const conn = new PeerConnection(ws, Protocol.WS, /*netAddress*/ null, peerAddress);
            this.fire('connection', conn);
        };
        ws.onerror = e => {
            this._timers.clearTimeout(timeoutKey);
            this.fire('error', peerAddress, e);
        };

        this._timers.setTimeout(timeoutKey, () => {
            this._timers.clearTimeout(timeoutKey);

            // We don't want to fire the error event again if the websocket
            // connect fails at a later time.
            ws.onerror = null;

            // If the connection succeeds after we have fired the error event,
            // close it.
            ws.onopen = () => {
                Log.w(WebSocketConnector, `Connection to ${peerAddress} succeeded after timeout - closing it`);
                ws.close();
            };

            this.fire('error', peerAddress, 'timeout');
        }, WebSocketConnector.CONNECT_TIMEOUT);

        return true;
    }
}
WebSocketConnector.CONNECT_TIMEOUT = 1000 * 5; // 5 seconds
Class.register(WebSocketConnector);

class Services {
    static myServices() {
        if (!Services._myServices) throw new Error('Services are not configured');
        return Services._myServices;
    }

    // Used for filtering peer addresses by services.
    static myServiceMask() {
        if (!Services._myServiceMask) throw new Error('ServiceMask is not configured');
        return Services._myServiceMask;
    }

    static configureServices(services) {
        Services._myServices = services;
    }

    static configureServiceMask(serviceMask) {
        Services._myServiceMask = serviceMask;
    }

    static isFullNode(services) {
        return (services & Services.FULL) !== 0;
    }

    static isLightNode(services) {
        return (services & Services.LIGHT) !== 0;
    }

    static isNanoNode(services) {
        return services === Services.NANO;
    }
}
Services.NANO   = 1;
Services.LIGHT  = 2;
Services.FULL   = 4;
Services.INDEX  = 8;
Class.register(Services);

class Synchronizer extends Observable {
    constructor() {
        super();
        this._queue = [];
        this._working = false;
    }

    /**
     * Push function to the Synchronizer for later, synchronous execution
     * @template T
     * @param {function():T} fn Function to be invoked later by this Synchronizer
     * @returns {Promise.<T>}
     */
    push(fn) {
        return new Promise((resolve, reject) => {
            this._queue.push({fn: fn, resolve: resolve, reject: reject});
            if (!this._working) {
                this._doWork();
            }
        });
    }

    /**
     * Reject all jobs in the queue and clear it.
     * @returns {void}
     */
    clear() {
        for (const job of this._queue) {
            if (job.reject) job.reject();
        }
        this._queue = [];
    }

    async _doWork() {
        this._working = true;
        this.fire('work-start', this);

        while (this._queue.length) {
            const job = this._queue.shift();
            try {
                const result = await job.fn();
                job.resolve(result);
            } catch (e) {
                if (job.reject) job.reject(e);
            }
        }

        this._working = false;
        this.fire('work-end', this);
    }

    /** @type {boolean} */
    get working() {
        return this._working;
    }
}
Class.register(Synchronizer);

class Timers {
    constructor() {
        this._timeouts = {};
        this._intervals = {};
    }

    setTimeout(key, fn, waitTime) {
        if (this._timeouts[key]) throw 'Duplicate timeout for key ' + key;
        this._timeouts[key] = setTimeout(fn, waitTime);
    }

    clearTimeout(key) {
        clearTimeout(this._timeouts[key]);
        delete this._timeouts[key];
    }

    resetTimeout(key, fn, waitTime) {
        clearTimeout(this._timeouts[key]);
        this._timeouts[key] = setTimeout(fn, waitTime);
    }

    timeoutExists(key) {
        return this._timeouts[key] !== undefined;
    }

    setInterval(key, fn, intervalTime) {
        if (this._intervals[key]) throw 'Duplicate interval for key ' + key;
        this._intervals[key] = setInterval(fn, intervalTime);
    }

    clearInterval(key) {
        clearInterval(this._intervals[key]);
        delete this._intervals[key];
    }

    resetInterval(key, fn, intervalTime) {
        clearInterval(this._intervals[key]);
        this._intervals[key] = setInterval(fn, intervalTime);
    }

    intervalExists(key) {
        return this._intervals[key] !== undefined;
    }

    clearAll() {
        for (const key in this._timeouts) {
            this.clearTimeout(key);
        }
        for (const key in this._intervals) {
            this.clearInterval(key);
        }
    }
}
Class.register(Timers);

class Version {
    static isCompatible(code) {
        return code === Version.CODE;
    }
}
Version.CODE = 3;
Class.register(Version);

class Time {
    static now() {
        return Date.now() + Time._timeOffset;
    }

    static set timeOffset(offset) {
        Time._timeOffset = offset;
    }
}
Time._timeOffset = 0;
Class.register(Time);

class ArrayUtils {
    /**
     * @template T
     * @param {Array.<T>} arr
     * @return {T}
     */
    static randomElement(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /**
     * @param {Uint8Array} uintarr
     * @param {number} begin
     * @param {number} end
     * @return {Uint8Array}
     */
    static subarray(uintarr, begin, end) {
        function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

        if (begin === undefined) { begin = 0; }
        if (end === undefined) { end = uintarr.byteLength; }

        begin = clamp(begin, 0, uintarr.byteLength);
        end = clamp(end, 0, uintarr.byteLength);

        let len = end - begin;
        if (len < 0) {
            len = 0;
        }

        return new Uint8Array(uintarr.buffer, uintarr.byteOffset + begin, len);
    }

    /**
     * @param {Array} list
     * @param {number} k
     * @return {Generator}
     */
    static *k_combinations(list, k) {
        const n = list.length;
        // Shortcut:
        if (k > n) {
            return;
        }
        const indices = Array.from(new Array(k), (x,i) => i);
        yield indices.map(i => list[i]);
        const reverseRange = Array.from(new Array(k), (x,i) => k-i-1);
        /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
        while (true) {
            let i = k-1, found = false;
            for (i of reverseRange) {
                if (indices[i] !== i + n - k) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                return;
            }
            indices[i] += 1;
            for (const j of Array.from(new Array(k-i-1), (x,k) => i+k+1)) {
                indices[j] = indices[j-1] + 1;
            }
            yield indices.map(i => list[i]);
        }
    }
}
Class.register(ArrayUtils);

/**
 * @template K,V
 */
class HashMap {
    constructor(fnHash = HashMap._hash) {
        /** @type {Map.<string,V>} */
        this._map = new Map();
        /** @type {function(o: object): string} */
        this._fnHash = fnHash;
    }

    /**
     * @param {{hashCode: function():string}|*} o
     * @returns {string}
     * @private
     */
    static _hash(o) {
        return o.hashCode ? o.hashCode() : o.toString();
    }

    /**
     * @param {K|*} key
     * @returns {V|*}
     */
    get(key) {
        return this._map.get(this._fnHash(key));
    }

    /**
     * @param {K|*} key
     * @param {V|*} value
     */
    put(key, value) {
        this._map.set(this._fnHash(key), value);
    }

    /**
     * @param {K|*} key
     */
    remove(key) {
        this._map.delete(this._fnHash(key));
    }

    clear() {
        this._map.clear();
    }

    /**
     * @param {K|*} key
     * @returns {boolean}
     */
    contains(key) {
        return this._map.has(this._fnHash(key));
    }

    /**
     * @returns {Array.<K|*>}
     */
    keys() {
        return Array.from(this._map.keys());
    }

    /**
     * @returns {Iterator.<K|*>}
     */
    keyIterator() {
        return this._map.keys();
    }

    /**
     * @returns {Array.<V|*>}
     */
    values() {
        return Array.from(this._map.values());
    }

    /**
     * @returns {Iterator.<V|*>}
     */
    valueIterator() {
        return this._map.values();
    }

    /**
     * @returns {number}
     */
    get length() {
        return this._map.size;
    }

    /**
     * @returns {boolean}
     */
    isEmpty() {
        return this._map.size === 0;
    }
}
Class.register(HashMap);

/**
 * @template V
 */
class HashSet {
    constructor(fnHash = HashSet._hash) {
        /** @type {Map.<string,V>} */
        this._map = new Map();
        /** @type {function(o: object): string} */
        this._fnHash = fnHash;
    }

    /**
     * @param {{hashCode: function():string}|*} o
     * @returns {string}
     * @private
     */
    static _hash(o) {
        return o.hashCode ? o.hashCode() : o.toString();
    }

    /**
     * @param {V|*} value
     */
    add(value) {
        this._map.set(this._fnHash(value), value);
    }

    /**
     * @param {Array.<V|*>} collection
     */
    addAll(collection) {
        for (const value of collection) {
            this.add(value);
        }
    }

    /**
     * @param {V|*} value
     * @returns {V|*}
     */
    get(value) {
        return this._map.get(this._fnHash(value));
    }

    /**
     * @param {V|*} value
     */
    remove(value) {
        this._map.delete(this._fnHash(value));
    }

    /**
     * @param {Array.<V|*>} collection
     */
    removeAll(collection) {
        for (const value of collection) {
            this.remove(value);
        }
    }

    clear() {
        this._map.clear();
    }

    /**
     * @param {V|*} value
     * @returns {boolean}
     */
    contains(value) {
        return this._map.has(this._fnHash(value));
    }

    /**
     * @returns {Array.<V|*>}
     */
    values() {
        return Array.from(this._map.values());
    }

    /**
     * @returns {Iterator.<V|*>}
     */
    valueIterator() {
        return this._map.values();
    }

    /**
     * @returns {Iterator.<V|*>}
     */
    [Symbol.iterator]() {
        return this.valueIterator();
    }

    /**
     * @returns {number}
     */
    get length() {
        return this._map.size;
    }

    /**
     * @returns {boolean}
     */
    isEmpty() {
        return this._map.size === 0;
    }
}
Class.register(HashSet);

/**
 * @template T
 * @implements {Iterable.<T>}
 */
class LimitIterable {
    /**
     * @param {Iterable.<T>|Iterator.<T>} it
     * @param {number} limit
     */
    constructor(it, limit) {
        /** @type {Iterator.<T>} */
        this._iterator = it[Symbol.iterator] ? it[Symbol.iterator]() : it;
        /** @type {number} */
        this._limit = limit;
    }

    /**
     * @returns {{next: function():object}}
     */
    [Symbol.iterator]() {
        return LimitIterable.iterator(this._iterator, this._limit);
    }

    /**
     * @template V
     * @param {Iterator.<V>} iterator
     * @param {number} limit
     * @returns {{next: function():object}}
     */
    static iterator(iterator, limit) {
        let count = 0;
        return {
            next: () => {
                const done = count++ >= limit;
                const next = iterator.next();
                return {
                    value: done ? undefined : next.value,
                    done: done || next.done
                };
            }
        };
    }
}
Class.register(LimitIterable);

class Queue {
    constructor(fnHash) {
        this._queue = [];
        this._fnHash = fnHash || Queue._hash;
    }

    static _hash(o) {
        return o.hashCode ? o.hashCode() : o.toString();
    }

    enqueue(value) {
        this._queue.push(value);
    }

    dequeue() {
        return this._queue.shift();
    }

    peek() {
        return this._queue[0];
    }

    /**
     * @param {*} value
     * @return {number}
     */
    indexOf(value) {
        const hash = this._fnHash(value);
        for (let i = 0; i < this._queue.length; ++i) {
            if (hash === this._fnHash(this._queue[i])) {
                return i;
            }
        }
        return -1;
    }

    remove(value) {
        const index = this.indexOf(value);
        if (index > -1) {
            this._queue.splice(index, 1);
        }
    }

    /**
     * @param {number} count
     * @return {Array}
     */
    dequeueMulti(count) {
        return this._queue.splice(0, count);
    }

    /**
     * @param {*} value
     * @return {Array}
     */
    dequeueUntil(value) {
        const index = this.indexOf(value);
        if (index > -1) {
            return this._queue.splice(0, index + 1);
        }
        return [];
    }

    clear() {
        this._queue = [];
    }

    values() {
        return this._queue;
    }

    /** @type {number} */
    get length() {
        return this._queue.length;
    }
}
Class.register(Queue);

class Assert {
    /**
     * @param {boolean} condition
     * @param {string} [message]
     * @returns {void}
     */
    static that(condition, message = 'Assertion failed') {
        if (!condition) throw new Error(message);
    }
}
Class.register(Assert);

class BufferUtils {
    /**
     * @param {*} buffer
     * @return {string}
     */
    static toAscii(buffer) {
        return String.fromCharCode.apply(null, new Uint8Array(buffer));
    }

    /**
     * @param {string} string
     * @return {Uint8Array}
     */
    static fromAscii(string) {
        var buf = new Uint8Array(string.length);
        for (let i = 0; i < string.length; ++i) {
            buf[i] = string.charCodeAt(i);
        }
        return buf;
    }

    /**
     * @param {*} buffer
     * @return {string}
     */
    static toBase64(buffer) {
        return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    }

    /**
     * @param {string} base64
     * @return {SerialBuffer}
     */
    static fromBase64(base64) {
        return new SerialBuffer(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    }

    /**
     * @param {*} buffer
     * @return {string}
     */
    static toBase64Url(buffer) {
        return BufferUtils.toBase64(buffer).replace(/\//g, '_').replace(/\+/g, '-').replace(/=/g, '.');
    }

    /**
     * @param {string} base64
     * @return {SerialBuffer}
     */
    static fromBase64Url(base64) {
        return new SerialBuffer(Uint8Array.from(atob(base64.replace(/_/g, '/').replace(/-/g, '+').replace(/\./g, '=')), c => c.charCodeAt(0)));
    }

    /**
     * @param {Uint8Array} buf
     * @param {string} [alphabet] Alphabet to use
     * @return {string}
     */
    static toBase32(buf, alphabet = BufferUtils.BASE32_ALPHABET.NIMIQ) {
        let shift = 3, carry = 0, byte, symbol, i, res = '';

        for (i = 0; i < buf.length; i++) {
            byte = buf[i];
            symbol = carry | (byte >> shift);
            res += alphabet[symbol & 0x1f];

            if (shift > 5) {
                shift -= 5;
                symbol = byte >> shift;
                res += alphabet[symbol & 0x1f];
            }

            shift = 5 - shift;
            carry = byte << shift;
            shift = 8 - shift;
        }

        if (shift !== 3) {
            res += alphabet[carry & 0x1f];
        }
        
        while (res.length % 8 !== 0 && alphabet.length === 33) {
            res += alphabet[32];
        }

        return res;
    }

    /**
     * @param {string} base32
     * @param {string} [alphabet] Alphabet to use
     * @return {Uint8Array}
     */
    static fromBase32(base32, alphabet = BufferUtils.BASE32_ALPHABET.NIMIQ) {
        const charmap = [];
        alphabet.toUpperCase().split('').forEach((c, i) => {
            if (!(c in charmap)) charmap[c] = i;
        });

        let symbol, shift = 8, carry = 0, buf = [];
        base32.toUpperCase().split('').forEach((char) => {
            // ignore padding
            if (alphabet.length === 33 && char === alphabet[32]) return;

            symbol = charmap[char] & 0xff;

            shift -= 5;
            if (shift > 0) {
                carry |= symbol << shift;
            } else if (shift < 0) {
                buf.push(carry | (symbol >> -shift));
                shift += 8;
                carry = (symbol << shift) & 0xff;
            } else {
                buf.push(carry | symbol);
                shift = 8;
                carry = 0;
            }
        });

        if (shift !== 8 && carry !== 0) {
            buf.push(carry);
        }

        return new Uint8Array(buf);
    }

    /**
     * @param {*} buffer
     * @return {string}
     */
    static toHex(buffer) {
        return Array.prototype.map.call(buffer, x => ('00' + x.toString(16)).slice(-2)).join('');
    }

    /**
     * @param {string} hex
     * @return {SerialBuffer}
     */
    static fromHex(hex) {
        hex = hex.trim();
        if (!StringUtils.isHexBytes(hex)) return null;
        return new SerialBuffer(Uint8Array.from(hex.match(/.{2}/g), byte => parseInt(byte, 16)));
    }

    /**
     * @template T
     * @param {T} a
     * @param {*} b
     * @return {T}
     */
    static concatTypedArrays(a, b) {
        const c = new (a.constructor)(a.length + b.length);
        c.set(a, 0);
        c.set(b, a.length);
        return c;
    }

    /**
     * @param {*} a
     * @param {*} b
     * @return {boolean}
     */
    static equals(a, b) {
        if (a.length !== b.length) return false;
        const viewA = new Uint8Array(a);
        const viewB = new Uint8Array(b);
        for (let i = 0; i < a.length; i++) {
            if (viewA[i] !== viewB[i]) return false;
        }
        return true;
    }

    /**
     * @param {*} a
     * @param {*} b
     * @return {number} -1 if a is smaller than b, 1 if a is larger than b, 0 if a equals b.
     */
    static compare(a, b) {
        if (a.length < b.length) return -1;
        if (a.length > b.length) return 1;
        for (let i = 0; i < a.length; i++) {
            if (a[i] < b[i]) return -1;
            if (a[i] > b[i]) return 1;
        }
        return 0;
    }
}
BufferUtils.BASE32_ALPHABET = {
    RFC4648:        'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=',
    RFC4648_HEX:    '0123456789ABCDEFGHIJKLMNOPQRSTUV=',
    NIMIQ:          '0123456789ABCDEFGHJKLMNPQRSTUVXY'
};

Class.register(BufferUtils);

class SerialBuffer extends Uint8Array {
    /**
     * @param {*} bufferOrArrayOrLength
     */
    constructor(bufferOrArrayOrLength) {
        super(bufferOrArrayOrLength);
        this._view = new DataView(this.buffer);
        this._readPos = 0;
        this._writePos = 0;
    }

    /**
     * @param {number} start
     * @param {number} end
     * @return {Uint8Array}
     */
    subarray(start, end) {
        return ArrayUtils.subarray(this, start, end);
    }

    /** @type {number} */
    get readPos() {
        return this._readPos;
    }

    /** @type {number} */
    set readPos(value) {
        if (value < 0 || value > this.byteLength) throw `Invalid readPos ${value}`;
        this._readPos = value;
    }

    /** @type {number} */
    get writePos() {
        return this._writePos;
    }

    /** @type {number} */
    set writePos(value) {
        if (value < 0 || value > this.byteLength) throw `Invalid writePos ${value}`;
        this._writePos = value;
    }

    /**
     * Resets the read and write position of the buffer to zero.
     * @returns {void}
     */
    reset() {
        this._readPos = 0;
        this._writePos = 0;
    }

    /**
     * @param {number} length
     * @return {Uint8Array}
     */
    read(length) {
        const value = this.subarray(this._readPos, this._readPos + length);
        this._readPos += length;
        return value;
    }

    /**
     * @param {*} array
     */
    write(array) {
        this.set(array, this._writePos);
        this._writePos += array.byteLength;
    }

    /**
     * @return {number}
     */
    readUint8() {
        return this._view.getUint8(this._readPos++);
    }

    /**
     * @param {number} value
     */
    writeUint8(value) {
        this._view.setUint8(this._writePos++, value);
    }

    /**
     * @return {number}
     */
    readUint16() {
        const value = this._view.getUint16(this._readPos);
        this._readPos += 2;
        return value;
    }

    /**
     * @param {number} value
     */
    writeUint16(value) {
        this._view.setUint16(this._writePos, value);
        this._writePos += 2;
    }

    /**
     * @return {number}
     */
    readUint32() {
        const value = this._view.getUint32(this._readPos);
        this._readPos += 4;
        return value;
    }

    /**
     * @param {number} value
     */
    writeUint32(value) {
        this._view.setUint32(this._writePos, value);
        this._writePos += 4;
    }

    /**
     * @return {number}
     */
    readUint64() {
        const value = this._view.getFloat64(this._readPos);
        if (!NumberUtils.isUint64(value)) throw new Error('Malformed value');
        this._readPos += 8;
        return value;
    }

    /**
     * @param {number} value
     */
    writeUint64(value) {
        if (!NumberUtils.isUint64(value)) throw new Error('Malformed value');
        this._view.setFloat64(this._writePos, value);
        this._writePos += 8;
    }

    /**
     * @return {number}
     */
    readVarUint() {
        const value = this.readUint8();
        if (value < 0xFD) {
            return value;
        } else if (value === 0xFD) {
            return this.readUint16();
        } else if (value === 0xFE) {
            return this.readUint32();
        } else /*if (value === 0xFF)*/ {
            return this.readUint64();
        }
    }

    /**
     * @param {number} value
     */
    writeVarUint(value) {
        if (!NumberUtils.isUint64(value)) throw new Error('Malformed value');
        if (value < 0xFD) {
            this.writeUint8(value);
        } else if (value <= 0xFFFF) {
            this.writeUint8(0xFD);
            this.writeUint16(value);
        } else if (value <= 0xFFFFFFFF) {
            this.writeUint8(0xFE);
            this.writeUint32(value);
        } else {
            this.writeUint8(0xFF);
            this.writeUint64(value);
        }
    }

    /**
     * @param {number} value
     * @returns {number}
     */
    static varUintSize(value) {
        if (!NumberUtils.isUint64(value)) throw new Error('Malformed value');
        if (value < 0xFD) {
            return 1;
        } else if (value <= 0xFFFF) {
            return 3;
        } else if (value <= 0xFFFFFFFF) {
            return 5;
        } else {
            return 9;
        }
    }

    /**
     * @return {number}
     */
    readFloat64() {
        const value = this._view.getFloat64(this._readPos);
        this._readPos += 8;
        return value;
    }

    /**
     * @param {number} value
     */
    writeFloat64(value) {
        this._view.setFloat64(this._writePos, value);
        this._writePos += 8;
    }

    /**
     * @param {number} length
     * @return {string}
     */
    readString(length) {
        const bytes = this.read(length);
        return BufferUtils.toAscii(bytes);
    }

    /**
     * @param {string} value
     * @param {number} length
     */
    writeString(value, length) {
        if (StringUtils.isMultibyte(value) || value.length !== length) throw 'Malformed value/length';
        const bytes = BufferUtils.fromAscii(value);
        this.write(bytes);
    }

    /**
     * @param {number} length
     * @return {string}
     */
    readPaddedString(length) {
        const bytes = this.read(length);
        let i = 0;
        while (i < length && bytes[i] !== 0x0) i++;
        const view = new Uint8Array(bytes.buffer, bytes.byteOffset, i);
        return BufferUtils.toAscii(view);
    }

    /**
     * @param {string} value
     * @param {number} length
     */
    writePaddedString(value, length) {
        if (StringUtils.isMultibyte(value) || value.length > length) throw 'Malformed value/length';
        const bytes = BufferUtils.fromAscii(value);
        this.write(bytes);
        const padding = length - bytes.byteLength;
        this.write(new Uint8Array(padding));
    }

    /**
     * @return {string}
     */
    readVarLengthString() {
        const length = this.readUint8();
        if (this._readPos + length > this.length) throw 'Malformed length';
        const bytes = this.read(length);
        return BufferUtils.toAscii(bytes);
    }

    /**
     * @param {string} value
     */
    writeVarLengthString(value) {
        if (StringUtils.isMultibyte(value) || !NumberUtils.isUint8(value.length)) throw new Error('Malformed value');
        const bytes = BufferUtils.fromAscii(value);
        this.writeUint8(bytes.byteLength);
        this.write(bytes);
    }
}
Class.register(SerialBuffer);

class Crypto {
    static get lib() { return CryptoLib.instance; }

    /**
     * @returns {Promise.<CryptoWorker>}
     * @private
     */
    static _cryptoWorkerSync() {
        if (!Crypto._cryptoWorkerPromiseSync) {
            Crypto._cryptoWorkerPromiseSync = new Promise(async (resolve) => {
                const impl = IWorker._workerImplementation[CryptoWorker.name];
                await impl.init('crypto');
                Crypto._cryptoWorkerResolvedSync = impl;
                resolve(impl);
            });
        }
        return Crypto._cryptoWorkerPromiseSync;
    }

    /**
     * @return {Promise}
     */
    static async prepareSyncCryptoWorker() {
        await Crypto._cryptoWorkerSync();
    }

    /**
     * @returns {Promise.<CryptoWorker>}
     * @private
     */
    static _cryptoWorkerAsync() {
        if (!Crypto._cryptoWorkerPromiseAsync) {
            Crypto._cryptoWorkerPromiseAsync = IWorker.startWorkerPoolForProxy(CryptoWorker, 'crypto', 4);
        }
        return Crypto._cryptoWorkerPromiseAsync;
    }

    // Signature implementation using ED25519 through WebAssembly
    static get publicKeySize() {
        return 32;
    }

    static get publicKeyType() {
        return Uint8Array;
    }

    static publicKeySerialize(key) {
        // key is already a Uint8Array
        return key;
    }

    static publicKeyUnserialize(key) {
        return key;
    }

    static async publicKeyDerive(privateKey) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.publicKeyDerive(privateKey);
    }

    static get privateKeySize() {
        return 32;
    }

    static get privateKeyType() {
        return Uint8Array;
    }

    static privateKeySerialize(key) {
        // already a Uint8Array
        return key;
    }

    static privateKeyUnserialize(key) {
        return key;
    }

    static privateKeyGenerate() {
        const privateKey = new Uint8Array(Crypto.privateKeySize);
        Crypto.lib.getRandomValues(privateKey);
        return privateKey;
    }

    static get keyPairType() {
        return Object;
    }

    static async keyPairGenerate() {
        return Crypto.keyPairDerive(Crypto.privateKeyGenerate());
    }

    static async keyPairDerive(privateKey) {
        return {
            privateKey,
            publicKey: await Crypto.publicKeyDerive(privateKey)
        };
    }

    static keyPairPrivate(obj) {
        return obj.privateKey;
    }

    static keyPairPublic(obj) {
        return obj.publicKey;
    }

    static keyPairFromKeys(privateKey, publicKey) {
        return { privateKey, publicKey };
    }

    static get randomnessSize() {
        return 32;
    }

    static async commitmentPairGenerate() {
        const randomness = new Uint8Array(Crypto.randomnessSize);
        Crypto.lib.getRandomValues(randomness);
        const worker = await Crypto._cryptoWorkerSync();
        return worker.commitmentCreate(randomness);
    }

    static commitmentPairFromValues(secret, commitment) {
        return { secret, commitment };
    }

    static commitmentPairRandomSecret(obj) {
        return obj.secret;
    }

    static commitmentPairCommitment(obj) {
        return obj.commitment;
    }

    static get commitmentPairType() {
        return Object;
    }

    static get randomSecretSize() {
        return 32;
    }

    static get randomSecretType() {
        return Uint8Array;
    }

    static randomSecretSerialize(key) {
        // secret is already a Uint8Array
        return key;
    }

    static randomSecretUnserialize(key) {
        return key;
    }

    static get commitmentSize() {
        return 32;
    }

    static get commitmentType() {
        return Uint8Array;
    }

    static commitmentSerialize(key) {
        // commitment is already a Uint8Array
        return key;
    }

    static commitmentUnserialize(key) {
        return key;
    }

    static async hashPublicKeys(publicKeys) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.publicKeysHash(publicKeys);
    }

    static async delinearizePublicKey(publicKeys, publicKey) {
        const worker = await Crypto._cryptoWorkerSync();
        const publicKeysHash = await worker.publicKeysHash(publicKeys);
        return worker.publicKeyDelinearize(publicKey, publicKeysHash);
    }

    static async delinearizePrivateKey(publicKeys, publicKey, privateKey) {
        const worker = await Crypto._cryptoWorkerSync();
        const publicKeysHash = await worker.publicKeysHash(publicKeys);
        return worker.privateKeyDelinearize(privateKey, publicKey, publicKeysHash);
    }

    static async delinearizeAndAggregatePublicKeys(publicKeys) {
        const worker = await Crypto._cryptoWorkerSync();
        const publicKeysHash = await worker.publicKeysHash(publicKeys);
        return worker.publicKeysDelinearizeAndAggregate(publicKeys, publicKeysHash);
    }

    static async delinearizedPartialSignatureCreate(privateKey, publicKey, publicKeys, secret, combinedCommitment, data) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.delinearizedPartialSignatureCreate(publicKeys, privateKey, publicKey, secret, combinedCommitment, data);
    }

    static async aggregateCommitments(commitments) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.commitmentsAggregate(commitments);
    }

    static async aggregatePartialSignatures(partialSignatures) {
        const worker = await Crypto._cryptoWorkerSync();
        return partialSignatures.reduce((sigA, sigB) => worker.scalarsAdd(sigA, sigB));
    }

    static async combinePartialSignatures(combinedCommitment, partialSignatures) {
        const combinedSignature = await Crypto.aggregatePartialSignatures(partialSignatures);
        return BufferUtils.concatTypedArrays(combinedCommitment, combinedSignature);
    }

    static async signatureCreate(privateKey, publicKey, data) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.signatureCreate(privateKey, publicKey, data);
    }

    static async signatureVerify(publicKey, data, signature) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.signatureVerify(publicKey, data, signature);
    }

    static partialSignatureSerialize(obj) {
        return obj;
    }

    static partialSignatureUnserialize(arr) {
        return arr;
    }

    static get partialSignatureSize() {
        return 32;
    }

    static get partialSignatureType() {
        return Uint8Array;
    }

    static signatureSerialize(obj) {
        return obj;
    }

    static signatureUnserialize(arr) {
        return arr;
    }

    static get signatureSize() {
        return 64;
    }

    static get signatureType() {
        return Uint8Array;
    }

    // Light hash implementation using SHA-256 with WebCrypto API and fast-sha256 fallback
    //
    // static get sha256() { return require('fast-sha256'); }
    //
    // static async hashLight(arr) {
    //     if (Crypto.lib) {
    //         return new Uint8Array(await Crypto.lib.digest('SHA-256', arr));
    //     } else {
    //         return new Promise((res) => {
    //             // Performs badly, but better than a dead UI
    //             setTimeout(() => {
    //                 res(new Crypto.sha256.Hash().update(arr).digest());
    //             });
    //         });
    //     }
    // }


    // Light hash implementation using blake2b via WebAssembly WebWorker
    static async hashLight(arr) {
        const worker = await Crypto._cryptoWorkerSync();
        return worker.computeLightHash(arr);
    }

    /**
     * @param arr
     * @return {Uint8Array}
     */
    static hashLightSync(arr) {
        const worker = Crypto._cryptoWorkerResolvedSync;
        if (!worker) throw new Error('Synchronous crypto worker not yet prepared');
        return worker.computeLightHash(arr);
    }

    // Light hash implementation using SHA-256 with WebCrypto API
    // static async hashLight(arr) {
    //     return new Uint8Array(await Crypto.lib.digest('SHA-256', arr));
    // }

    // Hard hash implementation using Argon2 via WebAssembly WebWorker
    static async hashHard(arr) {
        const worker = await Crypto._cryptoWorkerAsync();
        return worker.computeHardHash(arr);
    }

    static async hashHardBatch(arrarr) {
        const worker = await Crypto._cryptoWorkerAsync();
        return worker.computeHardHashBatch(arrarr);
    }

    static async kdf(key, seed) {
        const worker = await Crypto._cryptoWorkerAsync();
        return worker.kdf(key, seed);
    }

    /**
     * @param {Array.<BlockHeader>} headers
     * @return {Promise.<void>}
     */
    static async manyPow(headers) {
        const worker = await Crypto._cryptoWorkerAsync();
        const size = worker.poolSize || 1;
        let partitions = [];
        let j = 0;
        for (let i = 0; i < size; ++i) {
            partitions.push([]);
            for (; j < ((i + 1) / size) * headers.length; ++j) {
                partitions[i].push(headers[j].serialize());
            }
        }
        const promises = [];
        for (const part of partitions) {
            promises.push(worker.computeHardHashBatch(part));
        }
        const pows = (await Promise.all(promises)).reduce((a, b) => [...a, ...b], []);
        for(let i = 0; i < headers.length; ++i) {
            headers[i]._pow = new Hash(pows[i]);
        }
    }

    // Hard hash implementation using double light hash
    //static async hashHard(arr) {
    //    return Crypto.hashLight(await Crypto.hashLight(arr));
    //}

    // Hard hash implementation using light hash
    // static async hashHard(arr) {
    //     if (Crypto.lib._nimiq_callDigestDelayedWhenMining) {
    //         return await new Promise((resolve, error) => {
    //             window.setTimeout(() => {
    //                 Crypto.hashLight(arr).then(resolve);
    //             });
    //         });
    //     } else {
    //         return Crypto.hashLight(arr);
    //     }
    // }

    static get hashSize() {
        return 32;
    }

    static get hashType() {
        return Uint8Array;
    }
}

/** @type {Promise.<CryptoWorker>} */
Crypto._cryptoWorkerPromise = null;
/** @type {Promise.<CryptoWorker>} */
Crypto._cryptoWorkerPromiseSync = null;
/** @type {CryptoWorkerImpl} */
Crypto._cryptoWorkerResolvedSync = null;
Class.register(Crypto);

class CRC32 {
    static _createTable () {
        let b;
        const table = [];

        for (let j = 0; j < 256; ++j) {
            b = j;
            for (let k = 0; k < 8; ++k) {
                b = b & 1 ? CRC32._POLYNOMIAL ^ (b >>> 1) : b >>> 1;
            }
            table[j] = b >>> 0;
        }
        return table;
    }

    /**
     * @param {Uint8Array} buf
     * @returns {number}
     */
    static compute(buf) {
        if (!CRC32._table) CRC32._table = CRC32._createTable();
        if (!CRC32._hex_chars) CRC32._hex_chars = '0123456789abcdef'.split('');

        const message = new Uint8Array(buf);
        const initialValue = -1;

        let crc = initialValue;
        let hex = '';

        for (let i = 0; i < message.length; ++i) {
            crc = CRC32._table[(crc ^ message[i]) & 0xFF] ^ (crc >>> 8);
        }
        crc ^= initialValue;

        hex += CRC32._hex_chars[(crc >> 28) & 0x0F] + CRC32._hex_chars[(crc >> 24) & 0x0F] +
            CRC32._hex_chars[(crc >> 20) & 0x0F] + CRC32._hex_chars[(crc >> 16) & 0x0F] +
            CRC32._hex_chars[(crc >> 12) & 0x0F] + CRC32._hex_chars[(crc >> 8) & 0x0F] +
            CRC32._hex_chars[(crc >> 4) & 0x0F] + CRC32._hex_chars[crc & 0x0F];

        return parseInt(hex, 16);
    }
}
CRC32._table = null;
CRC32._hex_chars = null;
CRC32._POLYNOMIAL = 0xEDB88320;
Class.register(CRC32);

class NumberUtils {
    /**
     * @param {number} val
     * @return {boolean}
     */
    static isUint8(val) {
        return Number.isInteger(val)
            && val >= 0 && val <= NumberUtils.UINT8_MAX;
    }

    /**
     * @param {number} val
     * @return {boolean}
     */
    static isUint16(val) {
        return Number.isInteger(val)
            && val >= 0 && val <= NumberUtils.UINT16_MAX;
    }

    /**
     * @param {number} val
     * @return {boolean}
     */
    static isUint32(val) {
        return Number.isInteger(val)
            && val >= 0 && val <= NumberUtils.UINT32_MAX;
    }

    /**
     * @param {number} val
     * @return {boolean}
     */
    static isUint64(val) {
        return Number.isInteger(val)
            && val >= 0 && val <= NumberUtils.UINT64_MAX;
    }

    /**
     * @return {number}
     */
    static randomUint32() {
        return Math.floor(Math.random() * (NumberUtils.UINT32_MAX + 1));
    }

    /**
     * @return {number}
     */
    static randomUint64() {
        return Math.floor(Math.random() * (NumberUtils.UINT64_MAX + 1));
    }
}

NumberUtils.UINT8_MAX = 255;
NumberUtils.UINT16_MAX = 65535;
NumberUtils.UINT32_MAX = 4294967295;
NumberUtils.UINT64_MAX = Number.MAX_SAFE_INTEGER;
//Object.freeze(NumberUtils);
Class.register(NumberUtils);

class MerkleTree {
    /**
     * @param {Array} values
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<Hash>}
     */
    static computeRoot(values, fnHash = MerkleTree._hash) {
        return MerkleTree._computeRoot(values, fnHash);
    }

    /**
     * @param {Array} values
     * @param {function(o: *):Promise.<Hash>} fnHash
     * @returns {Promise.<Hash>}
     * @private
     */
    static _computeRoot(values, fnHash) {
        const len = values.length;
        if (len === 0) {
            return Hash.light(new Uint8Array(0));
        }
        if (len === 1) {
            return fnHash(values[0]);
        }

        const mid = Math.round(len / 2);
        const left = values.slice(0, mid);
        const right = values.slice(mid);
        return Promise.all([
            MerkleTree._computeRoot(left, fnHash),
            MerkleTree._computeRoot(right, fnHash)
        ]).then(hashes => {
            return Hash.light(BufferUtils.concatTypedArrays(hashes[0].serialize(), hashes[1].serialize()));
        });
    }

    /**
     * @param {Hash|Uint8Array|{hash: function():Promise.<Hash>}|{serialize: function():Uint8Array}} o
     * @returns {Promise.<Hash>}
     * @private
     */
    static _hash(o) {
        if (o instanceof Hash) {
            return Promise.resolve(o);
        }
        if (typeof o.hash === 'function') {
            return o.hash();
        }
        if (typeof o.serialize === 'function') {
            return Hash.light(o.serialize());
        }
        if (o instanceof Uint8Array) {
            return Hash.light(o);
        }
        throw new Error('MerkleTree objects must be Uint8Array or have a .hash()/.serialize() method');
    }
}
Class.register(MerkleTree);

class MerklePath {
    /**
     * @param {Array.<MerklePathNode>} nodes
     */
    constructor(nodes) {
        if (!Array.isArray(nodes) || !NumberUtils.isUint8(nodes.length)
            || nodes.some(it => !(it instanceof MerklePathNode))) throw new Error('Malformed nodes');
        /**
         * @type {Array.<MerklePathNode>}
         * @private
         */
        this._nodes = nodes;
    }

    /**
     * @param {Array} values
     * @param {*} leafValue
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<MerklePath>}
     */
    static async compute(values, leafValue, fnHash = MerkleTree._hash) {
        const leafHash = await fnHash(leafValue);
        const path = [];
        await MerklePath._compute(values, leafHash, path, fnHash);
        return new MerklePath(path);
    }

    /**
     * @param {Array} values
     * @param {Hash} leafHash
     * @param {Array.<MerklePathNode>} path
     * @param {function(o: *):Promise.<Hash>} fnHash
     * @returns {Promise.<{containsLeaf:boolean, inner:Hash}>}
     * @private
     */
    static async _compute(values, leafHash, path, fnHash) {
        const len = values.length;
        let hash;
        if (len === 0) {
            hash = await Hash.light(new Uint8Array(0));
            return {containsLeaf: false, inner: hash};
        }
        if (len === 1) {
            hash = await fnHash(values[0]);
            return {containsLeaf: hash.equals(leafHash), inner: hash};
        }

        const mid = Math.round(len / 2);
        const left = values.slice(0, mid);
        const right = values.slice(mid);
        const {containsLeaf: leftLeaf, inner: leftHash} = await MerklePath._compute(left, leafHash, path, fnHash);
        const {containsLeaf: rightLeaf, inner: rightHash} = await MerklePath._compute(right, leafHash, path, fnHash);
        hash = await Hash.light(BufferUtils.concatTypedArrays(leftHash.serialize(), rightHash.serialize()));

        if (leftLeaf) {
            path.push(new MerklePathNode(rightHash, false));
            return {containsLeaf: true, inner: hash};
        } else if (rightLeaf) {
            path.push(new MerklePathNode(leftHash, true));
            return {containsLeaf: true, inner: hash};
        }

        return {containsLeaf: false, inner: hash};
    }

    /**
     * @param {*} leafValue
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<Hash>}
     */
    async computeRoot(leafValue, fnHash = MerkleTree._hash) {
        /** @type {Hash} */
        let root = await fnHash(leafValue);
        for (const node of this._nodes) {
            const left = node.left;
            const hash = node.hash;
            const concat = new SerialBuffer(hash.serializedSize * 2);
            if (left) hash.serialize(concat);
            root.serialize(concat);
            if (!left) hash.serialize(concat);
            root = await Hash.light(concat);
        }
        return root;
    }

    /**
     * @param {Array.<MerklePathNode>} nodes
     * @returns {Uint8Array}
     * @private
     */
    static _compress(nodes) {
        const count = nodes.length;
        const leftBitsSize = Math.ceil(count / 8);
        const leftBits = new Uint8Array(leftBitsSize);

        for (let i = 0; i < count; i++) {
            if (nodes[i].left) {
                leftBits[Math.floor(i / 8)] |= 0x80 >>> (i % 8);
            }
        }

        return leftBits;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {MerklePath}
     */
    static unserialize(buf) {
        const count = buf.readUint8();
        const leftBitsSize = Math.ceil(count / 8);
        const leftBits = buf.read(leftBitsSize);

        const nodes = [];
        for (let i = 0; i < count; i++) {
            const left = (leftBits[Math.floor(i / 8)] & (0x80 >>> (i % 8))) !== 0;
            const hash = Hash.unserialize(buf);
            nodes.push(new MerklePathNode(hash, left));
        }
        return new MerklePath(nodes);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._nodes.length);
        buf.write(MerklePath._compress(this._nodes));

        for (const node of this._nodes) {
            node.hash.serialize(buf);
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        const leftBitsSize = Math.ceil(this._nodes.length / 8);
        return /*count*/ 1
            + leftBitsSize
            + this._nodes.reduce((sum, node) => sum + node.hash.serializedSize, 0);
    }

    /**
     * @param {MerklePath} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof MerklePath
            && this._nodes.length === o._nodes.length
            && this._nodes.every((node, i) => node.equals(o._nodes[i]));
    }

    /** @type {Array.<MerklePathNode>} */
    get nodes() {
        return this._nodes;
    }
}
Class.register(MerklePath);

class MerklePathNode {
    /**
     * @param {Hash} hash
     * @param {boolean} left
     */
    constructor(hash, left) {
        this._hash = hash;
        this._left = left;
    }

    /** @type {Hash} */
    get hash() {
        return this._hash;
    }

    /** @type {boolean} */
    get left() {
        return this._left;
    }

    /**
     * @param {MerklePathNode} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof MerklePathNode
            && this._hash.equals(o.hash)
            && this._left === o.left;
    }
}
Class.register(MerklePathNode);

class MerkleProof {
    /**
     * @param {Array.<*>} hashes
     * @param {Array.<MerkleProof.Operation>} operations
     */
    constructor(hashes, operations) {
        if (!Array.isArray(hashes) || !NumberUtils.isUint16(hashes.length)) throw new Error('Malformed nodes');
        if (!Array.isArray(operations) || !NumberUtils.isUint16(operations.length)) throw new Error('Malformed operations');
        /**
         * @type {Array.<*>}
         * @private
         */
        this._nodes = hashes;
        this._operations = operations;
    }

    /**
     * @param {Array} values
     * @param {Array.<*>} leafValues
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<MerkleProof>}
     */
    static async compute(values, leafValues, fnHash = MerkleTree._hash) {
        const leafHashes = await Promise.all(leafValues.map(fnHash));
        const {containsLeaf, operations, path, inner} = await MerkleProof._compute(values, leafHashes, fnHash);
        return new MerkleProof(path, operations);
    }

    /**
     * Assumes ordered array of values.
     * @param {Array} values
     * @param {Array.<*>} leafValues
     * @param {function(a: *, b: *):number} fnCompare
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<MerkleProof>}
     */
    static computeWithAbsence(values, leafValues, fnCompare, fnHash = MerkleTree._hash) {
        const leaves = new Set();
        leafValues = leafValues.slice();
        leafValues.sort(fnCompare);
        // Find missing leaves and include neighbours instead.
        let leafIndex = 0, valueIndex = 0;
        while (valueIndex < values.length && leafIndex < leafValues.length) {
            const value = values[valueIndex];
            const comparisonResult = fnCompare(value, leafValues[leafIndex]);
            // Leave is included.
            if (comparisonResult === 0) {
                leaves.add(leafValues[leafIndex]);
                ++leafIndex;
            }
            // Leave should already have been there, so it is missing.
            else if (comparisonResult > 0) {
                // Use both, prevValue and value, as a proof of absence.
                // Special case: prevValue unknown as we're at the first value.
                if (valueIndex > 0) {
                    leaves.add(values[valueIndex - 1]);
                }
                leaves.add(value);
                ++leafIndex;
            }
            // This value is not interesting for us, skip it.
            else {
                ++valueIndex;
            }
        }
        // If we processed all values but not all leaves, these are missing. Add last value as proof.
        if (leafIndex < leafValues.length && values.length > 0) {
            leaves.add(values[values.length - 1]);
        }

        return MerkleProof.compute(values, Array.from(leaves), fnHash);
    }

    /**
     * @param {Array} values
     * @param {Array.<Hash>} leafHashes
     * @param {function(o: *):Promise.<Hash>} fnHash
     * @returns {Promise.<{containsLeaf:boolean, inner:Hash}>}
     * @private
     */
    static async _compute(values, leafHashes, fnHash) {
        const len = values.length;
        let hash;
        if (len === 0) {
            hash = await Hash.light(new Uint8Array(0));
            return {containsLeaf: false, operations: [MerkleProof.Operation.CONSUME_PROOF], path: [hash], inner: hash};
        }
        if (len === 1) {
            hash = await fnHash(values[0]);
            const isLeaf = leafHashes.some(h => hash.equals(h));
            return {
                containsLeaf: isLeaf,
                operations: [isLeaf ? MerkleProof.Operation.CONSUME_INPUT : MerkleProof.Operation.CONSUME_PROOF],
                path: isLeaf ? [] : [hash],
                inner: hash
            };
        }

        const mid = Math.round(len / 2);
        const left = values.slice(0, mid);
        const right = values.slice(mid);
        const {containsLeaf: leftLeaf, operations: leftOps, path: leftPath, inner: leftHash} = await MerkleProof._compute(left, leafHashes, fnHash);
        const {containsLeaf: rightLeaf, operations: rightOps, path: rightPath, inner: rightHash} = await MerkleProof._compute(right, leafHashes, fnHash);
        hash = await Hash.light(BufferUtils.concatTypedArrays(leftHash.serialize(), rightHash.serialize()));

        // If a branch does not contain a leaf, we can directly use its hash and discard any inner operations.
        if (!leftLeaf && !rightLeaf) {
            return {containsLeaf: false, operations: [MerkleProof.Operation.CONSUME_PROOF], path: [hash], inner: hash};
        }

        // At least one branch contains a leaf, so execute all operations.
        let operations = leftOps;
        operations = operations.concat(rightOps);
        let path = leftPath;
        path = path.concat(rightPath);

        operations.push(MerkleProof.Operation.HASH);

        return {containsLeaf: true, operations: operations, path: path, inner: hash};
    }

    /**
     * @param {Array.<*>} leafValues
     * @param {function(o: *):Promise.<Hash>} [fnHash]
     * @returns {Promise.<Hash>}
     */
    async computeRoot(leafValues, fnHash = MerkleTree._hash) {
        /** @type {Array.<Hash>} */
        const inputs = await Promise.all(leafValues.map(fnHash));
        const stack = [];
        const proofNodes = this._nodes.slice();
        for (const op of this._operations) {
            switch (op) {
                case MerkleProof.Operation.CONSUME_PROOF:
                    if (proofNodes.length === 0) {
                        throw new Error('Invalid operation.');
                    }
                    stack.push(proofNodes.shift());
                    break;
                case MerkleProof.Operation.CONSUME_INPUT:
                    if (inputs.length === 0) {
                        throw new Error('Invalid operation.');
                    }
                    stack.push(inputs.shift());
                    break;
                case MerkleProof.Operation.HASH: {
                    if (stack.length < 2) {
                        throw new Error('Invalid operation.');
                    }
                    const hashStack = stack.splice(-2, 2);
                    const concat = new SerialBuffer(hashStack.reduce((size, hash) => size + hash.serializedSize, 0));
                    const [left, right] = hashStack;
                    left.serialize(concat);
                    right.serialize(concat);
                    stack.push(await Hash.light(concat));
                    break;
                }
                default:
                    throw new Error('Invalid operation.');
            }
        }
        // Everything but the root needs to be consumed.
        if (stack.length !== 1 || proofNodes.length !== 0 || inputs.length !== 0) {
            throw Error('Did not consume all nodes.');
        }
        return stack[0];
    }

    /**
     * @param {Array.<MerkleProof.Operation>} operations
     * @returns {Uint8Array}
     * @private
     */
    static _compress(operations) {
        const count = operations.length;
        const opBitsSize = Math.ceil(count / 4);
        const opBits = new Uint8Array(opBitsSize);

        for (let i = 0; i < count; i++) {
            const op = operations[i] & 0x3;
            opBits[Math.floor(i / 4)] |= op << (i % 4) * 2;
        }

        return opBits;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {MerkleProof}
     */
    static unserialize(buf) {
        const opCount = buf.readUint16();
        const opBitsSize = Math.ceil(opCount / 4);
        const opBits = buf.read(opBitsSize);

        const operations = [];
        for (let i = 0; i < opCount; i++) {
            const op = ((opBits[Math.floor(i / 4)] >>> (i % 4) * 2) & 0x3);
            operations.push(op);
        }

        const countNodes = buf.readUint16();
        const hashes = [];
        for (let i = 0; i < countNodes; i++) {
            hashes.push(Hash.unserialize(buf));
        }
        return new MerkleProof(hashes, operations);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._operations.length);
        buf.write(MerkleProof._compress(this._operations));
        buf.writeUint16(this._nodes.length);
        for (const hash of this._nodes) {
            hash.serialize(buf);
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        const opBitsSize = Math.ceil(this._operations.length / 4);
        return /*counts*/ 4
            + opBitsSize
            + this._nodes.reduce((sum, node) => sum + node.serializedSize, 0);
    }

    /**
     * @param {MerkleProof} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof MerkleProof
            && this._nodes.length === o._nodes.length
            && this._nodes.every((node, i) => node.equals(o._nodes[i]))
            && this._operations.length === o._operations.length
            && this._operations.every((op, i) => op === o._operations[i]);
    }

    /** @type {Array.<Hash>} */
    get nodes() {
        return this._nodes;
    }
}
/** @enum {number} */
MerkleProof.Operation = {
    CONSUME_PROOF: 0,
    CONSUME_INPUT: 1,
    HASH: 2
};
Class.register(MerkleProof);

class PlatformUtils {
    /**
     * @returns {boolean}
     */
    static isBrowser() {
        return typeof window !== 'undefined';
    }

    /**
     * @return {boolean}
     */
    static isNodeJs() {
        return !PlatformUtils.isBrowser() && typeof process === 'object' && typeof require === 'function';
    }

    /**
     * @returns {boolean}
     */
    static supportsWebRTC() {
        let RTCPeerConnection = PlatformUtils.isBrowser() ? (window.RTCPeerConnection || window.webkitRTCPeerConnection) : null;
        return !!RTCPeerConnection;
    }

    /**
     * @returns {boolean}
     */
    static isOnline() {
        return (!PlatformUtils.isBrowser() || !('onLine' in window.navigator)) || window.navigator.onLine;
    }
}
Class.register(PlatformUtils);

class StringUtils {
    /**
     * @param {string} str
     * @returns {boolean}
     */
    static isMultibyte(str) {
        return /[\uD800-\uDFFF]/.test(str);
    }

    /**
     * @param {string} str
     * @returns {boolean}
     */
    static isHex(str) {
        return /[0-9A-Fa-f]*/.test(str);
    }

    /**
     * @param {string} str
     * @param {number} [length]
     * @returns {boolean}
     */
    static isHexBytes(str, length) {
        if (!StringUtils.isHex(str)) return false;
        if (str.length % 2 !== 0) return false;
        if (typeof length === 'number' && str.length / 2 !== length) return false;
        return true;
    }

    /**
     * @param {string} str1
     * @param {string} str2
     * @returns {string}
     */
    static commonPrefix(str1, str2) {
        let i = 0;
        for (; i < str1.length; ++i) {
            if (str1[i] !== str2[i]) break;
        }
        return str1.substr(0, i);
    }

}
Class.register(StringUtils);

class Policy {
    /**
     * Convert Nimiq decimal to Number of Satoshis.
     * @param {number} coins Nimiq count in decimal
     * @return {number} Number of Satoshis
     */
    static coinsToSatoshis(coins) {
        return Math.round(coins * Policy.SATOSHIS_PER_COIN);
    }

    /**
     * Convert Number of Satoshis to Nimiq decimal.
     * @param {number} satoshis Number of Satoshis.
     * @return {number} Nimiq count in decimal.
     */
    static satoshisToCoins(satoshis) {
        return satoshis / Policy.SATOSHIS_PER_COIN;
    }

    /**
     * Number of Satoshis per Nimiq.
     * @type {number}
     * @constant
     */
    static get SATOSHIS_PER_COIN() {
        return 1e8;
    }

    /**
     * Targeted block time in seconds.
     * @type {number}
     * @constant
     */
    static get BLOCK_TIME() {
        return 60; // Seconds
    }

    /**
     * Targeted total supply.
     * @type {number}
     * @constant
     */
    static get TOTAL_SUPPLY() {
        return Policy.coinsToSatoshis(21e6);
    }

    /**
     * Initial supply before genesis block.
     * FIXME: Change for main net.
     * @type {number}
     * @constant
     */
    static get INITIAL_SUPPLY() {
        return Policy.coinsToSatoshis(0);
    }

    /**
     * Emission speed.
     * @type {number}
     * @constant
     */
    static get EMISSION_SPEED() {
        return Math.pow(2, 22);
    }

    /**
     * First block using constant tail emission until total supply is reached.
     * @type {number}
     * @constant
     */
    static get EMISSION_TAIL_START() {
        return 48696986;
    }

    /**
     * Constant amount of tail emission until total supply is reached.
     * @type {number}
     * @constant
     */
    static get EMISSION_TAIL_REWARD() {
        return 4000; // satoshi
    }

    /**
     * First block using new block reward scheme.
     * FIXME: Remove for main net.
     * @type {number}
     * @constant
     */
    static get EMISSION_CURVE_START() {
        return 35000;
    }

    /**
     * Circulating supply after block.
     * @param {number} initialSupply
     * @param {number} blockHeight
     * @param {number} [startHeight]
     * @return {number}
     */
    static _supplyAfter(initialSupply, blockHeight, startHeight=0) {
        let supply = initialSupply;
        for (let i = startHeight; i <= blockHeight; ++i) {
            supply += Policy._blockRewardAt(supply, i);
        }
        return supply;
    }

    /**
     * Circulating supply after block.
     * @param {number} blockHeight
     * @return {number}
     */
    static supplyAfter(blockHeight) {
        // FIXME: Change for main net.
        if (blockHeight < Policy.EMISSION_CURVE_START) {
            return Policy.INITIAL_SUPPLY + (blockHeight+1) * Policy.coinsToSatoshis(5);
        }
        // Luna net supply after start of emission curve.
        const initialSupply = Policy.INITIAL_SUPPLY + Policy.EMISSION_CURVE_START * Policy.coinsToSatoshis(5);

        // Calculate last entry in supply cache that is below blockHeight.
        let startHeight = Math.floor(blockHeight / Policy._supplyCacheInterval) * Policy._supplyCacheInterval;
        startHeight = Math.max(/* FIXME change to 0 for main net */ Policy.EMISSION_CURVE_START, Math.min(startHeight, Policy._supplyCacheMax));

        // Calculate respective block for the last entry of the cache and the targeted height.
        const startI = startHeight / Policy._supplyCacheInterval;
        const endI = Math.floor(blockHeight / Policy._supplyCacheInterval);

        // The starting supply is the initial supply at the beginning and a cached value afterwards.
        let supply = startHeight === /* FIXME change to 0 for main net */ Policy.EMISSION_CURVE_START ? initialSupply : Policy._supplyCache.get(startHeight);
        // Use and update cache.
        for (let i=startI; i<endI; ++i) {
            startHeight = i * Policy._supplyCacheInterval;
            // Since the cache stores the supply *before* a certain block, subtract one.
            const endHeight = (i+1) * Policy._supplyCacheInterval - 1;
            supply = Policy._supplyAfter(supply, endHeight, startHeight);
            // Don't forget to add one again.
            Policy._supplyCache.set(endHeight + 1, supply);
            Policy._supplyCacheMax = endHeight + 1;
        }

        // Calculate remaining supply (this also adds the block reward for endI*interval).
        return Policy._supplyAfter(supply, blockHeight, endI*Policy._supplyCacheInterval);
    }

    /**
     * Miner reward per block.
     * @param {number} currentSupply
     * @param {number} blockHeight
     * @return {number}
     */
    static _blockRewardAt(currentSupply, blockHeight) {
        const remaining = Policy.TOTAL_SUPPLY - currentSupply;
        if (blockHeight >= Policy.EMISSION_TAIL_START && remaining >= Policy.EMISSION_TAIL_REWARD) {
            return Policy.EMISSION_TAIL_REWARD;
        }
        const remainder = remaining % Policy.EMISSION_SPEED;
        return (remaining-remainder) / Policy.EMISSION_SPEED;
    }

    /**
     * Miner reward per block.
     * @param {number} blockHeight
     * @return {number}
     */
    static blockRewardAt(blockHeight) {
        // FIXME: Change for main net.
        if (blockHeight >= Policy.EMISSION_CURVE_START) {
            const currentSupply = Policy.supplyAfter(blockHeight - 1);
            return Policy._blockRewardAt(currentSupply, blockHeight);
        }
        return Policy.coinsToSatoshis(5);
    }

    /**
     * Maximum block size in bytes.
     * @type {number}
     * @constant
     */
    static get BLOCK_SIZE_MAX() {
        return 1e6; // 1 MB
    }

    /**
     * The highest (easiest) block PoW target.
     * @type {number}
     * @constant
     */
    static get BLOCK_TARGET_MAX() {
        return BlockUtils.compactToTarget(0x1f00ffff); // 16 zero bits, bitcoin uses 32 (0x1d00ffff)
    }

    /**
     * Number of blocks we take into account to calculate next difficulty.
     * @type {number}
     * @constant
     */
    static get DIFFICULTY_BLOCK_WINDOW() {
        return 120; // Blocks
    }

    /**
     * Limits the rate at which the difficulty is adjusted min/max.
     * @type {number}
     * @constant
     */
    static get DIFFICULTY_MAX_ADJUSTMENT_FACTOR() {
        return 2;
    }


    /* NIPoPoW parameters */

    /**
     * Security parameter M
     * FIXME naming
     * @type {number}
     * @constant
     */
    static get M() {
        return 240;
    }

    /**
     * Security parameter K
     * FIXME naming
     * @type {number}
     * @constant
     */
    static get K() {
        return 120;
    }

    /**
     * Security parameter DELTA
     * FIXME naming
     * @type {number}
     * @constant
     */
    static get DELTA() {
        return 0.1;
    }

    /* Snapshot Parameters */
    /**
     * Maximum number of snapshots.
     * @type {number}
     * @constant
     */
    static get NUM_SNAPSHOTS_MAX() {
        return 20;
    }

    /**
     * Security parameter M
     * FIXME naming
     * @type {number}
     * @constant
     */
    static get NUM_BLOCKS_VERIFICATION() {
        return 250;
    }
}
/**
 * Stores the supply before the given block.
 * @type {Map.<number, number>}
 */
Policy._supplyCache = new Map();
Policy._supplyCacheMax = 0; // blocks
Policy._supplyCacheInterval = 5000; // blocks
Class.register(Policy);

/**
 * @abstract
 */
class Primitive {
    /**
     * @param arg
     * @param type
     * @param {?number} length
     */
    constructor(arg, type, length) {
        if (type && !(arg instanceof type)) throw new Error('Primitive: Invalid type');
        if (length && arg.length && arg.length !== length) throw new Error('Primitive: Invalid length');
        this._obj = arg;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Primitive && BufferUtils.equals(this.serialize(), o.serialize());
    }

    /**
     * @param {Primitive} o
     * @return {number} negative if this is smaller than o, positive if this is larger than o, zero if equal.
     */
    compare(o) {
        if (typeof this._obj.compare === 'function') {
            return this._obj.compare(o._obj);
        } else if (this._obj.prototype === o._obj.prototype) {
            return BufferUtils.compare(this.serialize(), o.serialize());
        }

        throw new Error(`Incomparable types: ${this._obj.constructor.name} and ${o._obj.constructor.name}`);
    }

    hashCode() {
        return this.toBase64();
    }

    /**
     * @abstract
     * @param {SerialBuffer} [buf]
     */
    serialize(buf) {}

    /**
     * @return {string}
     */
    toString() {
        return this.toBase64();
    }

    /**
     * @return {string}
     */
    toBase64() {
        return BufferUtils.toBase64(this.serialize());
    }

    /**
     * @return {string}
     */
    toHex() {
        return BufferUtils.toHex(this.serialize());
    }
}

Class.register(Primitive);

class Hash extends Primitive {
    /**
     * @param {Hash} o
     * @returns {Hash}
     */
    static copy(o) {
        if (!o) return o;
        // FIXME Move this to Crypto class.
        const obj = new Uint8Array(o._obj);
        return new Hash(obj);
    }

    /**
     * @param {?Uint8Array} arg
     * @private
     */
    constructor(arg) {
        if (arg === null) {
            arg = new Uint8Array(Crypto.hashSize);
        }
        super(arg, Crypto.hashType, Crypto.hashSize);
    }

    /**
     * @param {Uint8Array} arr
     * @return {Promise.<Hash>}
     */
    static async light(arr) {
        return new Hash(await Crypto.hashLight(arr));
    }

    /**
     * @param {Uint8Array} arr
     * @return {Hash}
     */
    static lightSync(arr) {
        return new Hash(Crypto.hashLightSync(arr));
    }

    /**
     * @param {Uint8Array} arr
     * @return {Promise.<Hash>}
     */
    static async hard(arr) {
        return new Hash(await Crypto.hashHard(arr));
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Hash}
     */
    static unserialize(buf) {
        return new Hash(buf.read(Crypto.hashSize));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(this._obj);
        return buf;
    }

    /**
     * @param {number} begin
     * @param {number} end
     * @return {Uint8Array}
     */
    subarray(begin, end) {
        return this._obj.subarray(begin, end);
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.hashSize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Hash && super.equals(o);
    }

    /**
     * @param {string} base64
     * @return {Hash}
     */
    static fromBase64(base64) {
        return new Hash(BufferUtils.fromBase64(base64));
    }

    /**
     * @param {string} hex
     * @return {Hash}
     */
    static fromHex(hex) {
        return new Hash(BufferUtils.fromHex(hex));
    }

    /**
     * @param {Hash} o
     * @return {boolean}
     */
    static isHash(o) {
        return o instanceof Hash;
    }
}
Class.register(Hash);

class PrivateKey extends Primitive {
    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.privateKeyType, Crypto.privateKeySize);
    }

    /**
     * @return {Promise.<PrivateKey>}
     */
    static async generate() {
        return new PrivateKey(await Crypto.privateKeyGenerate());
    }

    /**
     * @param {SerialBuffer} buf
     * @return {PrivateKey}
     */
    static unserialize(buf) {
        return new PrivateKey(Crypto.privateKeyUnserialize(buf.read(Crypto.privateKeySize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.privateKeySerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.privateKeySize;
    }

    /**
     * Overwrite this private key with a replacement in-memory
     * @param {PrivateKey} privateKey
     */
    overwrite(privateKey) {
        this._obj.set(privateKey._obj);
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof PrivateKey && super.equals(o);
    }
}

Class.register(PrivateKey);

class PublicKey extends Primitive {
    /**
     * @param {PublicKey} o
     * @returns {PublicKey}
     */
    static copy(o) {
        if (!o) return o;
        return new PublicKey(new Uint8Array(o._obj));
    }

    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.publicKeyType, Crypto.publicKeySize);
    }

    /**
     * @param {PrivateKey} privateKey
     * @return {Promise.<PublicKey>}
     */
    static async derive(privateKey) {
        return new PublicKey(await Crypto.publicKeyDerive(privateKey._obj));
    }

    /**
     * @param {Array.<PublicKey>} publicKeys
     * @return {Promise.<PublicKey>}
     */
    static async sum(publicKeys) {
        return new PublicKey(await Crypto.delinearizeAndAggregatePublicKeys(publicKeys.map(key => key._obj)));
    }

    /**
     * @param {SerialBuffer} buf
     * @return {PublicKey}
     */
    static unserialize(buf) {
        return new PublicKey(Crypto.publicKeyUnserialize(buf.read(Crypto.publicKeySize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.publicKeySerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.publicKeySize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof PublicKey && super.equals(o);
    }

    /**
     * @return {Promise.<Hash>}
     */
    hash() {
        return Hash.light(this.serialize());
    }

    /**
     * @return {Hash}
     */
    hashSync() {
        return Hash.lightSync(this.serialize());
    }

    /**
     * @param {PublicKey} o
     * @return {number}
     */
    compare(o) {
        return BufferUtils.compare(this._obj, o._obj);
    }

    /**
     * @return {Promise.<Address>}
     */
    async toAddress() {
        return Address.fromHash(await this.hash());
    }

    /**
     * @return {Address}
     */
    toAddressSync() {
        return Address.fromHash(Hash.lightSync(this.serialize()));
    }

    /**
     * @return {Promise.<SignalId>}
     */
    async toSignalId() {
        return new SignalId((await this.hash()).subarray(0, 16));
    }
}

Class.register(PublicKey);

class KeyPair extends Primitive {
    /**
     * @param arg
     * @param {boolean} locked
     * @param {Uint8Array} lockSeed
     * @private
     */
    constructor(arg, locked = false, lockSeed = null) {
        super(arg, Crypto.keyPairType);
        /** @type {boolean} */
        this._locked = locked;
        /** @type {boolean} */
        this._unlocked = false;
        /** @type {Uint8Array} */
        this._lockSeed = lockSeed;
    }

    /**
     * @return {Promise.<KeyPair>}
     */
    static async generate() {
        return new KeyPair(await Crypto.keyPairGenerate());
    }

    /**
     * @param {PrivateKey} privateKey
     * @return {Promise.<KeyPair>}
     */
    static async derive(privateKey) {
        return new KeyPair(await Crypto.keyPairDerive(privateKey._obj));
    }

    /**
     * @param {SerialBuffer} buf
     * @return {KeyPair}
     */
    static unserialize(buf) {
        const privateKey = PrivateKey.unserialize(buf);
        const publicKey = PublicKey.unserialize(buf);
        let locked = false;
        let lockSeed = null;
        if (buf.readPos < buf.byteLength) {
            const extra = buf.readUint8();
            if (extra === 1) {
                locked = true;
                lockSeed = buf.read(32);
            }
        }
        return new KeyPair(Crypto.keyPairFromKeys(privateKey._obj, publicKey._obj), locked, lockSeed);
    }

    /**
     * @param {string} hexBuf
     * @return {KeyPair}
     */
    static fromHex(hexBuf) {
        return this.unserialize(BufferUtils.fromHex(hexBuf));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._privateKeyInternal.serialize(buf);
        this.publicKey.serialize(buf);
        if (this._locked) {
            buf.writeUint8(1);
            buf.write(this._lockSeed);
        } else {
            buf.writeUint8(0);
        }
        return buf;
    }

    /** @type {PrivateKey} */
    get privateKey() {
        if (this.isLocked) throw new Error('Wallet is locked');
        return this._privateKeyInternal;
    }

    /** @type {PrivateKey} */
    get _privateKeyInternal() {
        return this._privateKey || (this._privateKey = new PrivateKey(Crypto.keyPairPrivate(this._obj)));
    }

    /** @type {PublicKey} */
    get publicKey() {
        return this._publicKey || (this._publicKey = new PublicKey(Crypto.keyPairPublic(this._obj)));
    }

    /** @type {number} */
    get serializedSize() {
        return this._privateKeyInternal.serializedSize + this.publicKey.serializedSize + (this._locked ? this._lockSeed.byteLength + 1 : 1);
    }

    /**
     * @param {Uint8Array} key
     * @param {Uint8Array} [lockSeed]
     */
    async lock(key, lockSeed) {
        if (this._locked) throw new Error('KeyPair already locked');
        if (lockSeed) this._lockSeed = lockSeed;
        if (!this._lockSeed || this._lockSeed.length === 0) {
            this._lockSeed = new Uint8Array(32);
            Crypto.lib.getRandomValues(this._lockSeed);
        }
        this._privateKeyInternal.overwrite(await this._otpPrivateKey(key));
        this._locked = true;
        this._unlocked = false;
    }

    /**
     * @param {Uint8Array} key
     */
    async unlock(key) {
        if (!this._locked) throw new Error('KeyPair not locked');
        const privateKey = await this._otpPrivateKey(key);
        const verifyPub = await PublicKey.derive(privateKey);
        if (verifyPub.equals(this.publicKey)) {
            this._privateKey = privateKey;
            this._locked = false;
            this._unlocked = true;
        } else {
            throw new Error('Invalid key');
        }
    }

    relock() {
        if (this._locked) throw new Error('KeyPair already locked');
        if (!this._unlocked) throw new Error('KeyPair was never locked');
        this._privateKey.overwrite(PrivateKey.unserialize(new SerialBuffer(this._privateKey.serializedSize)));
        this._privateKey = null;
        this._locked = true;
        this._unlocked = false;
    }

    async _otpPrivateKey(key) {
        return new PrivateKey(KeyPair._xor(this._privateKeyInternal.serialize(), await Crypto.kdf(key, this._lockSeed)));
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @return {Uint8Array}
     * @private
     */
    static _xor(a, b) {
        const res = new Uint8Array(a.byteLength);
        for (let i = 0; i < a.byteLength; ++i) {
            res[i] = a[i] ^ b[i];
        }
        return res;
    }

    get isLocked() {
        return this._locked;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof KeyPair && super.equals(o);
    }
}
KeyPair.LOCK_ROUNDS = 100;
Class.register(KeyPair);

class RandomSecret extends Primitive {
    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.randomSecretType, Crypto.randomSecretSize);
    }

    /**
     * @param {SerialBuffer} buf
     * @return {RandomSecret}
     */
    static unserialize(buf) {
        return new RandomSecret(Crypto.randomSecretUnserialize(buf.read(Crypto.randomSecretSize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.randomSecretSerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.randomSecretSize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof RandomSecret && super.equals(o);
    }
}

Class.register(RandomSecret);

class Commitment extends Primitive {
    /**
     * @param {Commitment} o
     * @returns {Commitment}
     */
    static copy(o) {
        if (!o) return o;
        return new Commitment(new Uint8Array(o._obj));
    }

    /**
     * @param {Array.<Commitment>} commitments
     * @return {Promise.<Commitment>}
     */
    static async sum(commitments) {
        return new Commitment(await Crypto.aggregateCommitments(commitments.map(c => c._obj)));
    }

    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.commitmentType, Crypto.commitmentSize);
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Commitment}
     */
    static unserialize(buf) {
        return new Commitment(Crypto.commitmentUnserialize(buf.read(Crypto.commitmentSize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.commitmentSerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.commitmentSize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Commitment && super.equals(o);
    }
}

Class.register(Commitment);

class CommitmentPair extends Primitive {
    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.commitmentPairType);
    }

    /**
     * @return {Promise.<CommitmentPair>}
     */
    static async generate() {
        return new CommitmentPair(await Crypto.commitmentPairGenerate());
    }

    /**
     * @param {SerialBuffer} buf
     * @return {CommitmentPair}
     */
    static unserialize(buf) {
        const secret = RandomSecret.unserialize(buf);
        const commitment = Commitment.unserialize(buf);
        return new CommitmentPair(Crypto.commitmentPairFromValues(secret._obj, commitment._obj));
    }

    /**
     * @param {string} hexBuf
     * @return {CommitmentPair}
     */
    static fromHex(hexBuf) {
        return this.unserialize(BufferUtils.fromHex(hexBuf));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this.secret.serialize(buf);
        this.commitment.serialize(buf);
        return buf;
    }

    /** @type {RandomSecret} */
    get secret() {
        return this._secret || (this._secret = new RandomSecret(Crypto.commitmentPairRandomSecret(this._obj)));
    }

    /** @type {Commitment} */
    get commitment() {
        return this._commitment || (this._commitment = new Commitment(Crypto.commitmentPairCommitment(this._obj)));
    }

    /** @type {number} */
    get serializedSize() {
        return this.secret.serializedSize + this.commitment.serializedSize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof CommitmentPair && super.equals(o);
    }
}
CommitmentPair.SERIALIZED_SIZE = Crypto.randomSecretSize + Crypto.commitmentSize;
Class.register(CommitmentPair);

class Signature extends Primitive {
    /**
     * @param {Signature} o
     * @returns {Signature}
     */
    static copy(o) {
        if (!o) return o;
        // FIXME Move this to Crypto class.
        const obj = new Uint8Array(o._obj);
        return new Signature(obj);
    }

    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.signatureType, Crypto.signatureSize);
    }

    /**
     * @param {PrivateKey} privateKey
     * @param {PublicKey} publicKey
     * @param {Uint8Array} data
     * @return {Promise.<Signature>}
     */
    static async create(privateKey, publicKey, data) {
        return new Signature(await Crypto.signatureCreate(privateKey._obj, publicKey._obj, data));
    }

    /**
     * @param {Commitment} commitment
     * @param {Array.<PartialSignature>} signatures
     * @return {Promise.<Signature>}
     */
    static async fromPartialSignatures(commitment, signatures) {
        return new Signature(await Crypto.combinePartialSignatures(commitment._obj, signatures.map(s => s._obj)));
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Signature}
     */
    static unserialize(buf) {
        return new Signature(Crypto.signatureUnserialize(buf.read(Crypto.signatureSize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.signatureSerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.signatureSize;
    }

    /**
     * @param {PublicKey} publicKey
     * @param {Uint8Array} data
     * @return {Promise.<boolean>}
     */
    verify(publicKey, data) {
        return Crypto.signatureVerify(publicKey._obj, data, this._obj);
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Signature && super.equals(o);
    }
}
Class.register(Signature);

class PartialSignature extends Primitive {
    /**
     * @param arg
     * @private
     */
    constructor(arg) {
        super(arg, Crypto.partialSignatureType, Crypto.partialSignatureSize);
    }

    /**
     * @param {PrivateKey} privateKey
     * @param {PublicKey} publicKey
     * @param {Array.<PublicKey>} publicKeys
     * @param {RandomSecret} secret
     * @param {Commitment} aggregateCommitment
     * @param {Uint8Array} data
     * @return {Promise.<PartialSignature>}
     */
    static async create(privateKey, publicKey, publicKeys, secret, aggregateCommitment, data) {
        return new PartialSignature(await Crypto.delinearizedPartialSignatureCreate(privateKey._obj, publicKey._obj,
            publicKeys.map(o => o._obj), secret._obj, aggregateCommitment._obj, data));
    }

    /**
     * @param {SerialBuffer} buf
     * @return {PartialSignature}
     */
    static unserialize(buf) {
        return new PartialSignature(Crypto.partialSignatureUnserialize(buf.read(Crypto.signatureSize)));
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(Crypto.partialSignatureSerialize(this._obj));
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return Crypto.partialSignatureSize;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof PartialSignature && super.equals(o);
    }
}
Class.register(PartialSignature);

class Address extends Primitive {
    /**
     * @param {Address} o
     * @returns {Address}
     */
    static copy(o) {
        if (!o) return o;
        const obj = new Uint8Array(o._obj);
        return new Address(obj);
    }

    /**
     * @param {Hash} hash
     * @returns {Address}
     */
    static fromHash(hash) {
        return new Address(hash.subarray(0, Address.SERIALIZED_SIZE));
    }

    constructor(arg) {
        super(arg, Uint8Array, Address.SERIALIZED_SIZE);
    }

    /**
     * Create Address object from binary form.
     * @param {SerialBuffer} buf Buffer to read from.
     * @return {Address} Newly created Account object.
     */
    static unserialize(buf) {
        return new Address(buf.read(Address.SERIALIZED_SIZE));
    }

    /**
     * Serialize this Address object into binary form.
     * @param {?SerialBuffer} [buf] Buffer to write to.
     * @return {SerialBuffer} Buffer from `buf` or newly generated one.
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(this._obj);
        return buf;
    }

    subarray(begin, end) {
        return this._obj.subarray(begin, end);
    }

    /**
     * @type {number}
     */
    get serializedSize() {
        return Address.SERIALIZED_SIZE;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Address
            && super.equals(o);
    }

    /**
     * @param {string} base64
     * @return {Address}
     */
    static fromBase64(base64) {
        return new Address(BufferUtils.fromBase64(base64));
    }

    /**
     * @param {string} hex
     * @return {Address}
     */
    static fromHex(hex) {
        return new Address(BufferUtils.fromHex(hex));
    }

    /**
     * @param {string} str
     * @return {Address}
     */
    static fromUserFriendlyAddress(str) {
        str = str.replace(/ /g, '');
        if (str.substr(0, 2).toUpperCase() !== Address.CCODE) {
            throw new Error('Invalid Address: Wrong country code', 201);
        }
        if (str.length !== 36) {
            throw new Error('Invalid Address: Should be 36 chars (ignoring spaces)', 202);
        }
        if (Address._ibanCheck(str.substr(4) + str.substr(0, 4)) !== 1) {
            throw new Error('Invalid Address: Checksum invalid', 203);
        }
        return new Address(BufferUtils.fromBase32(str.substr(4)));
    }

    static _ibanCheck(str) {
        const num = str.split('').map((c) => {
            const code = c.toUpperCase().charCodeAt(0);
            return code >= 48 && code <= 57 ? c : (code - 55).toString();
        }).join('');
        let tmp = '';

        for (let i = 0; i < Math.ceil(num.length / 6); i++) {
            tmp = (parseInt(tmp + num.substr(i * 6, 6)) % 97).toString();
        }

        return parseInt(tmp);
    }

    /**
     * @param {boolean} [withSpaces]
     * @return {string}
     */
    toUserFriendlyAddress(withSpaces = true) {
        const base32 = BufferUtils.toBase32(this.serialize());
        // eslint-disable-next-line prefer-template
        const check = ('00' + (98 - Address._ibanCheck(base32 + Address.CCODE + '00'))).slice(-2);
        let res = Address.CCODE + check + base32;
        if (withSpaces) res = res.replace(/.{4}/g, '$& ').trim();
        return res;
    }
}
Address.CCODE = 'NQ';
Address.SERIALIZED_SIZE = 20;
Address.HEX_SIZE = 40;
Class.register(Address);

/**
 * @abstract
 */
class Account {
    /**
     * @param {Account} o
     * @returns {Account}
     */
    static copy(o) {
        if (!o) return o;
        let type = o._type;
        if (!type) type = Account.Type.BASIC;
        return Account.TYPE_MAP.get(type).copy(o);
    }

    /**
     * @param {Account.Type} type
     * @param {number} balance
     * @param {number} nonce
     */
    constructor(type, balance, nonce) {
        if (!NumberUtils.isUint8(type)) throw new Error('Malformed type');
        if (!NumberUtils.isUint64(balance)) throw new Error('Malformed balance');
        if (!NumberUtils.isUint32(nonce)) throw new Error('Malformed nonce');

        /** @type {Account.Type} */
        this._type = type;
        /** @type {number} */
        this._balance = balance;
        /** @type {number} */
        this._nonce = nonce;
    }

    /**
     * Create Account object from binary form.
     * @param {SerialBuffer} buf Buffer to read from.
     * @return {Account} Newly created Account object.
     */
    static unserialize(buf) {
        const type = /** @type {Account.Type} */ buf.readUint8();
        buf.readPos--;

        if (!Account.TYPE_MAP.has(type)) {
            throw new Error('Unknown account type');
        }

        return Account.TYPE_MAP.get(type).unserialize(buf);
    }

    /**
     * Serialize this Account object into binary form.
     * @param {?SerialBuffer} [buf] Buffer to write to.
     * @return {SerialBuffer} Buffer from `buf` or newly generated one.
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._type);
        buf.writeUint64(this._balance);
        buf.writeUint32(this._nonce);
        return buf;
    }

    /**
     * @return {number}
     */
    get serializedSize() {
        return /*type*/ 1
            + /*balance*/ 8
            + /*nonce*/ 4;
    }

    /**
     * Check if two Accounts are the same.
     * @param {Account} o Object to compare with.
     * @return {boolean} Set if both objects describe the same data.
     */
    equals(o) {
        return o instanceof Account
            && this._type === o._type
            && this._balance === o._balance
            && this._nonce === o._nonce;
    }

    toString() {
        return `Account{type=${this._type}, balance=${this._balance.toString()}`;
    }

    /**
     * @type {number} Account balance
     */
    get balance() {
        return this._balance;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }

    /** @type {Account.Type} */
    get type() {
        return this._type;
    }

    /**
     * @param {Array.<Transaction>} transactions
     * @param {number} blockHeight
     * @param {boolean} silent
     * @return {Promise.<boolean>}
     */
    verifyOutgoingTransactionSet(transactions, blockHeight, silent = false) {
        let account = this;
        for (let i = 0; i < transactions.length; ++i) {
            const tx = transactions[i];
            if (account._type !== tx.senderType) {
                if (!silent) Log.w(Account, 'Rejected transaction - sender type must match account type');
                return Promise.resolve(false);
            }
            if (account._nonce !== tx.nonce) {
                if (!silent) Log.d(Account, 'Rejected transaction - invalid nonce', tx);
                return Promise.resolve(false);
            }
            if (account._balance < tx.value + tx.fee) {
                if (!silent) Log.w(Account, 'Rejected transaction - insufficient funds', tx);
                return Promise.resolve(false);
            }
            try {
                account = account.withOutgoingTransaction(tx, blockHeight);
            } catch (e) {
                if (!silent) Log.w(Account, `Rejected transaction - ${e.message || e}`, tx);
                return Promise.resolve(false);
            }
        }
        return Promise.resolve(true);
    }

    /**
     * @param {number} balance
     * @param {number} [nonce]
     * @return {Account|*}
     */
    withBalance(balance, nonce) { throw new Error('Not yet implemented.'); }

    /**
     * @param {Transaction} transaction
     * @param {number} blockHeight
     * @param {boolean} [revert]
     * @return {Account|*}
     */
    withOutgoingTransaction(transaction, blockHeight, revert = false) {
        if (!revert) {
            const newBalance = this._balance - transaction.value - transaction.fee;
            if (newBalance < 0) {
                throw new Error('Balance Error!');
            }
            if (transaction.nonce !== this._nonce) {
                throw new Error('Nonce Error!');
            }
            return this.withBalance(newBalance, this._nonce + 1);
        } else {
            if (transaction.nonce !== this._nonce - 1) {
                throw new Error('Nonce Error!');
            }
            return this.withBalance(this._balance + transaction.value + transaction.fee, this._nonce - 1);
        }
    }

    /**
     * @param {Transaction} transaction
     * @param {number} blockHeight
     * @param {boolean} [revert]
     * @return {Account}
     */
    withIncomingTransaction(transaction, blockHeight, revert = false) {
        if (!revert) {
            return this.withBalance(this._balance + transaction.value, this._nonce);
        } else {
            const newBalance = this._balance - transaction.value;
            if (newBalance < 0) {
                throw new Error('Balance Error!');
            }
            return this.withBalance(newBalance, this._nonce);
        }
    }

    /**
     * @return {boolean}
     */
    isInitial() {
        return this._nonce === 0 && this._balance === 0;
    }
}

/**
 * Enum for Account types.
 * @enum
 */
Account.Type = {
    /**
     * Basic account type.
     * @see {BasicAccount}
     */
    BASIC: 0,
    /**
     * Account with vesting functionality.
     * @see {VestingAccount}
     */
    VESTING: 1
};
/**
 * @type {Map.<Account.Type, {INITIAL: Account, copy: function(o: *):Account, unserialize: function(buf: SerialBuffer):Account, verifyOutgoingTransaction: function(transaction: Transaction):Promise.<boolean>, verifyIncomingTransaction: function(transaction: Transaction):Promise.<boolean>}>}
 */
Account.TYPE_MAP = new Map();

Class.register(Account);

/**
 * This is a classic account that can send all his funds or receive any transaction.
 * All outgoing transactions are signed using the any key corresponding to this address.
 */
class BasicAccount extends Account {
    /**
     * @param {BasicAccount} o
     * @returns {BasicAccount}
     */
    static copy(o) {
        if (!o) return o;
        return new BasicAccount(o._balance, o._nonce);
    }

    /**
     * @param {number} [balance]
     * @param {number} [nonce]
     */
    constructor(balance = 0, nonce = 0) {
        super(Account.Type.BASIC, balance, nonce);
    }

    /**
     * @param {SerialBuffer} buf
     * @return {BasicAccount}
     */
    static unserialize(buf) {
        const type = buf.readUint8();
        if (type !== Account.Type.BASIC) throw new Error('Invalid account type');

        const balance = buf.readUint64();
        const nonce = buf.readUint32();
        return new BasicAccount(balance, nonce);
    }

    toString() {
        return `BasicAccount{balance=${this._balance}, nonce=${this._nonce}}`;
    }
    
    /**
     * @param {Transaction} transaction
     * @return {Promise.<boolean>}
     */
    static verifyOutgoingTransaction(transaction) {
        return SignatureProof.verifyTransaction(transaction);
    }

    /**
     * @param {Transaction} transaction
     * @return {Promise.<boolean>}
     */
    static verifyIncomingTransaction(transaction) {
        return Promise.resolve(true); // Accept everything
    }

    /**
     * @param {number} balance
     * @param {number} [nonce]
     * @return {Account|*}
     */
    withBalance(balance, nonce) { 
        return new BasicAccount(balance, typeof nonce === 'undefined' ? this._nonce : nonce);
    }
}
BasicAccount.INITIAL = new BasicAccount(0, 0);
Account.TYPE_MAP.set(Account.Type.BASIC, BasicAccount);
Class.register(BasicAccount);

class VestingAccount extends Account {
    /**
     * @param {VestingAccount} o
     * @returns {VestingAccount}
     */
    static copy(o) {
        if (!o) return o;
        return new VestingAccount(o._balance, o._nonce, o._vestingStart, o._vestingStepBlocks, o._vestingStepAmount, o._vestingTotalAmount);
    }

    /**
     * @param {number} [balance]
     * @param {number} [nonce]
     * @param {number} [vestingStart]
     * @param {number} [vestingStepBlocks]
     * @param {number} [vestingStepAmount]
     * @param {number} [vestingTotalAmount]
     */
    constructor(balance = 0, nonce = 0, vestingStart = 0, vestingStepBlocks = 0, vestingStepAmount = balance, vestingTotalAmount = balance) {
        super(Account.Type.VESTING, balance, nonce);
        if (!NumberUtils.isUint32(vestingStart)) throw new Error('Malformed vestingStart');
        if (!NumberUtils.isUint32(vestingStepBlocks)) throw new Error('Malformed vestingStepBlocks');
        if (!NumberUtils.isUint64(vestingStepAmount)) throw new Error('Malformed vestingStepAmount');
        if (!NumberUtils.isUint64(vestingTotalAmount)) throw new Error('Malformed lowerCap');

        /** @type {number} */
        this._vestingStart = vestingStart;
        /** @type {number} */
        this._vestingStepBlocks = vestingStepBlocks;
        /** @type {number} */
        this._vestingStepAmount = vestingStepAmount;
        /** @type {number} */
        this._vestingTotalAmount = vestingTotalAmount;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {VestingAccount}
     */
    static unserialize(buf) {
        const type = buf.readUint8();
        if (type !== Account.Type.VESTING) throw new Error('Invalid account type');

        const balance = buf.readUint64();
        const nonce = buf.readUint32();
        const vestingStart = buf.readUint32();
        const vestingStepBlocks = buf.readUint32();
        const vestingStepAmount = buf.readUint64();
        const vestingTotalAmount = buf.readUint64();
        return new VestingAccount(balance, nonce, vestingStart, vestingStepBlocks, vestingStepAmount, vestingTotalAmount);
    }

    /**
     * Serialize this VestingAccount object into binary form.
     * @param {?SerialBuffer} [buf] Buffer to write to.
     * @return {SerialBuffer} Buffer from `buf` or newly generated one.
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint32(this._vestingStart);
        buf.writeUint32(this._vestingStepBlocks);
        buf.writeUint64(this._vestingStepAmount);
        buf.writeUint64(this._vestingTotalAmount);
        return buf;
    }

    /**
     * @return {number}
     */
    get serializedSize() {
        return /*type*/ 1
            + /*balance*/ 8
            + /*nonce*/ 4
            + /*vestingStart*/ 4
            + /*vestingStepBlocks*/ 4
            + /*vestingStepAmount*/ 8
            + /*vestingTotalAmount*/ 8;
    }

    /** @type {number} */
    get vestingStart() {
        return this._vestingStart;
    }

    /** @type {number} */
    get vestingStepBlocks() {
        return this._vestingStepBlocks;
    }

    /** @type {number} */
    get vestingStepAmount() {
        return this._vestingStepAmount;
    }

    /** @type {number} */
    get vestingTotalAmount() {
        return this._vestingTotalAmount;
    }

    toString() {
        return `VestingAccount{balance=${this._balance}, nonce=${this._nonce}}`;
    }

    /**
     * @param {Transaction} transaction
     * @return {Promise.<boolean>}
     */
    static verifyOutgoingTransaction(transaction) {
        return SignatureProof.verifyTransaction(transaction);
    }

    /**
     * @param {Transaction} transaction
     * @return {Promise.<boolean>}
     */
    static verifyIncomingTransaction(transaction) {
        if (transaction.data.length > 0 && transaction.data.length !== 4 && transaction.data.length !== 16 && transaction.data.length !== 24) {
            return Promise.resolve(false);
        }
        return Promise.resolve(true); // Accept
    }

    /**
     * @param {number} balance
     * @param {number} [nonce]
     * @return {Account|*}
     */
    withBalance(balance, nonce) {
        return new VestingAccount(balance, typeof nonce === 'undefined' ? this._nonce : nonce, this._vestingStart, this._vestingStepBlocks, this._vestingStepAmount, this._vestingTotalAmount);
    }

    /**
     * @param {Transaction} transaction
     * @param {number} blockHeight
     * @param {boolean} [revert]
     * @return {Account|*}
     */
    withOutgoingTransaction(transaction, blockHeight, revert = false) {
        if (!revert) {
            const minCap = this._vestingStepBlocks && this._vestingStepAmount > 0 ? Math.max(0, this._vestingTotalAmount - Math.floor((blockHeight - this._vestingStart) / this._vestingStepBlocks) * this._vestingStepAmount) : 0;
            const newBalance = this._balance - transaction.value - transaction.fee;
            if (newBalance < minCap) {
                throw new Error('Balance Error!');
            }
        }
        return super.withOutgoingTransaction(transaction, blockHeight, revert);
    }

    /**
     * @param {Transaction} transaction
     * @param {number} blockHeight
     * @param {boolean} [revert]
     * @return {Account}
     */
    withIncomingTransaction(transaction, blockHeight, revert = false) {
        if (this === VestingAccount.INITIAL && transaction.data.length > 0) {
            /** @type {number} */
            let vestingStart, vestingStepBlocks, vestingStepAmount, vestingTotalAmount;
            const buf = new SerialBuffer(transaction.data);
            vestingTotalAmount = transaction.value;
            switch (transaction.data.length) {
                case 4:
                    // Only block number: vest full amount at that block
                    vestingStart = 0;
                    vestingStepBlocks = buf.readUint32();
                    vestingStepAmount = vestingTotalAmount;
                    break;
                case 16:
                    vestingStart = buf.readUint32();
                    vestingStepBlocks = buf.readUint32();
                    vestingStepAmount = buf.readUint64();
                    break;
                case 24:
                    // Create a vesting account with some instantly vested funds
                    vestingStart = buf.readUint32();
                    vestingStepBlocks = buf.readUint32();
                    vestingStepAmount = buf.readUint64();
                    vestingTotalAmount = buf.readUint64();
                    break;
                default:
                    throw new Error('Invalid transaction data');
            }
            return new VestingAccount(transaction.value, 0, vestingStart, vestingStepBlocks, vestingStepAmount, vestingTotalAmount);
        } else if (revert && transaction.data.length > 0) {
            return VestingAccount.INITIAL;
        } else if (transaction.data.length > 0) {
            throw new Error('Illegal transaction data');
        }
        return super.withIncomingTransaction(transaction, blockHeight, revert);
    }
}

VestingAccount.INITIAL = new VestingAccount();
Account.TYPE_MAP.set(Account.Type.VESTING, VestingAccount);
Class.register(VestingAccount);

class AccountsTreeNode {
    /**
     * @param {string} prefix
     * @param {Account} account
     * @returns {AccountsTreeNode}
     */
    static terminalNode(prefix, account) {
        return new AccountsTreeNode(AccountsTreeNode.TERMINAL, prefix, account);
    }

    /**
     * @param {string} prefix
     * @param {Array.<string>} childrenSuffixes
     * @param {Array.<Hash>} childrenHashes
     * @returns {AccountsTreeNode}
     */
    static branchNode(prefix, childrenSuffixes = [], childrenHashes = []) {
        if (childrenSuffixes.length !== childrenHashes.length) {
            throw new Error('Invalid list of children for branch node');
        }
        return new AccountsTreeNode(AccountsTreeNode.BRANCH, prefix, childrenSuffixes, childrenHashes);
    }

    /**
     * @param {AccountsTreeNode} o
     * @returns {AccountsTreeNode}
     */
    static copy(o) {
        if (!o) return o;
        return AccountsTreeNode.unserialize(new SerialBuffer(o));
    }

    /**
     * @param type
     * @param {string} prefix
     * @param {Account|Array.<string>} arg
     * @param {Array.<Hash>} [arg2]
     */
    constructor(type, prefix = '', arg, arg2 = []) {
        this._type = type;
        /** @type {string} */
        this._prefix = prefix;
        if (this.isBranch()) {
            /** @type {Array.<string>} */
            this._childrenSuffixes = arg;
            /** @type {Array.<Hash>} */
            this._childrenHashes = arg2;
        } else if (this.isTerminal()) {
            /** @type {Account} */
            this._account = arg;
        } else {
            throw `Invalid AccountsTreeNode type: ${type}`;
        }
    }

    /**
     * @param type
     * @returns {boolean}
     */
    static isTerminalType(type) {
        return type === AccountsTreeNode.TERMINAL;
    }

    /**
     * @param type
     * @returns {boolean}
     */
    static isBranchType(type) {
        return type === AccountsTreeNode.BRANCH;
    }


    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsTreeNode}
     */
    static unserialize(buf) {
        const type = buf.readUint8();
        const prefix = buf.readVarLengthString();

        if (AccountsTreeNode.isTerminalType(type)) {
            // Terminal node
            const account = Account.unserialize(buf);
            return AccountsTreeNode.terminalNode(prefix, account);
        } else if (AccountsTreeNode.isBranchType(type)) {
            // Branch node
            const childrenSuffixes = [], childrenHashes = [];
            const childCount = buf.readUint8();
            for (let i = 0; i < childCount; ++i) {
                const childSuffix = buf.readVarLengthString();
                const childHash = Hash.unserialize(buf);
                const childIndex = parseInt(childSuffix[0], 16);
                childrenSuffixes[childIndex] = childSuffix;
                childrenHashes[childIndex] = childHash;
            }
            return AccountsTreeNode.branchNode(prefix, childrenSuffixes, childrenHashes);
        } else {
            throw `Invalid AccountsTreeNode type: ${type}`;
        }
    }

    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._type);
        buf.writeVarLengthString(this._prefix);
        if (this.isTerminal()) {
            // Terminal node
            this._account.serialize(buf);
        } else {
            // Branch node
            const childCount = this._childrenSuffixes.reduce((count, child) => count + !!child, 0);
            buf.writeUint8(childCount);
            for (let i = 0; i < this._childrenSuffixes.length; ++i) {
                if (this._childrenHashes[i]) {
                    buf.writeVarLengthString(this._childrenSuffixes[i]);
                    this._childrenHashes[i].serialize(buf);
                }
            }
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let payloadSize;
        if (this.isTerminal()) {
            payloadSize = this._account.serializedSize;
        } else {
            // The children array contains undefined values for non existing children.
            // Only count existing ones.
            const childrenSize = this._childrenHashes.reduce((sum, child, i) => sum + (child ? child.serializedSize + this._childrenSuffixes[i].length + /*suffix varLengthString*/ 1 : 0), 0);
            payloadSize = /*childCount*/ 1 + childrenSize;
        }

        return /*type*/ 1
            + /*extra byte varLengthString prefix*/ 1
            + this._prefix.length
            + payloadSize;
    }

    /**
     * @returns {SerialBuffer}
     */
    stripDown() {
        return this.serialize();
    }

    /**
     * @param {string} prefix
     * @returns {?Hash}
     */
    getChildHash(prefix) {
        return this._childrenHashes && this._childrenHashes[this._getChildIndex(prefix)];
    }

    /**
     * @param {string} prefix
     * @returns {?string}
     */
    getChild(prefix) {
        const suffix = this._childrenSuffixes && this._childrenSuffixes[this._getChildIndex(prefix)];
        if (suffix) {
            return this.prefix + suffix;
        }
        return suffix;
    }

    /**
     * @param {string} prefix
     * @param {Hash} childHash
     * @returns {AccountsTreeNode}
     */
    withChild(prefix, childHash) {
        const childrenSuffixes = this._childrenSuffixes.slice() || [];
        const childrenHashes = this._childrenHashes.slice() || [];
        childrenSuffixes[this._getChildIndex(prefix)] = prefix.substr(this.prefix.length);
        childrenHashes[this._getChildIndex(prefix)] = childHash;
        return AccountsTreeNode.branchNode(this._prefix, childrenSuffixes, childrenHashes);
    }

    /**
     * @param {string} prefix
     * @returns {AccountsTreeNode}
     */
    withoutChild(prefix) {
        const childrenSuffixes = this._childrenSuffixes.slice() || [];
        const childrenHashes = this._childrenHashes.slice() || [];
        delete childrenSuffixes[this._getChildIndex(prefix)];
        delete childrenHashes[this._getChildIndex(prefix)];
        return AccountsTreeNode.branchNode(this._prefix, childrenSuffixes, childrenHashes);
    }

    /**
     * @returns {boolean}
     */
    hasChildren() {
        return this._childrenSuffixes && this._childrenSuffixes.some(child => !!child);
    }

    /**
     * @returns {boolean}
     */
    hasSingleChild() {
        return this._childrenSuffixes && this._childrenSuffixes.reduce((count, child) => count + !!child, 0) === 1;
    }

    /**
     * @returns {?string}
     */
    getFirstChild() {
        if (!this._childrenSuffixes) {
            return undefined;
        }
        const suffix = this._childrenSuffixes.find(child => !!child);
        return suffix ? this.prefix + suffix : undefined;
    }

    /**
     * @returns {?string}
     */
    getLastChild() {
        if (!this._childrenSuffixes) {
            return undefined;
        }
        for (let i = this._childrenSuffixes.length - 1; i >= 0; --i) {
            if (this._childrenSuffixes[i]) {
                return this.prefix + this._childrenSuffixes[i];
            }
        }
        return undefined;
    }

    /**
     * @returns {?Array.<string>}
     */
    getChildren() {
        if (!this._childrenSuffixes) {
            return undefined;
        }
        return this._childrenSuffixes.filter(child => !!child).map(child => this.prefix + child);
    }

    /** @type {Account} */
    get account() {
        return this._account;
    }

    /** @type {string} */
    get prefix() {
        return this._prefix;
    }

    /** @type {string} */
    set prefix(value) {
        this._prefix = value;
        this._hash = undefined;
    }

    /**
     * @param {Account} account
     * @returns {AccountsTreeNode}
     */
    withAccount(account) {
        return AccountsTreeNode.terminalNode(this._prefix, account);
    }

    /**
     * @returns {Promise.<Hash>}
     */
    async hash() {
        if (!this._hash) {
            this._hash = await Hash.light(this.serialize());
        }
        return this._hash;
    }

    /**
     * Tests if this node is a child of some other node.
     * @param {AccountsTreeNode} parent
     * @returns {boolean}
     */
    isChildOf(parent) {
        return parent.getChildren() && parent.getChildren().includes(this._prefix);
    }

    /**
     * @returns {boolean}
     */
    isTerminal() {
        return AccountsTreeNode.isTerminalType(this._type);
    }

    /**
     * @returns {boolean}
     */
    isBranch() {
        return AccountsTreeNode.isBranchType(this._type);
    }

    /**
     * @param {string} prefix
     * @returns {number}
     * @private
     */
    _getChildIndex(prefix) {
        Assert.that(prefix.substr(0, this.prefix.length) === this.prefix, `Prefix ${prefix} is not a child of the current node ${this.prefix}`);
        return parseInt(prefix[this.prefix.length], 16);
    }

    /**
     * @param {AccountsTreeNode} o
     * @returns {boolean}
     */
    equals(o) {
        if (!(o instanceof AccountsTreeNode)) return false;
        if (!Object.is(this.prefix, o.prefix)) return false;
        if (this.isTerminal()) {
            return o.isTerminal() && o._account.equals(this._account);
        } else {
            if (!o.isBranch()) return false;
            if (this._childrenSuffixes.length !== o._childrenSuffixes.length) return false;
            if (o._childrenSuffixes.length !== o._childrenHashes.length) return false;
            for (let i = 0; i < this._childrenSuffixes.length; ++i) {
                // hashes of child nodes
                const ourChild = this._childrenHashes[i];
                const otherChild = o._childrenHashes[i];
                if (ourChild) {
                    if (!otherChild || !ourChild.equals(otherChild)) return false;
                } else {
                    if (otherChild) return false;
                }
                if (this._childrenSuffixes[i] !== o._childrenSuffixes[i]) return false;
            }
        }
        return true;
    }
}
AccountsTreeNode.BRANCH = 0x00;
AccountsTreeNode.TERMINAL = 0xff;
Class.register(AccountsTreeNode);

class AccountsTreeStore {
    /**
     * @param {JungleDB} jdb
     */
    static initPersistent(jdb) {
        jdb.createObjectStore('Accounts', new AccountsTreeStoreCodec());
    }

    /**
     * @param {JungleDB} jdb
     * @returns {AccountsTreeStore}
     */
    static getPersistent(jdb) {
        return new AccountsTreeStore(jdb.getObjectStore('Accounts'));
    }

    /**
     * @returns {AccountsTreeStore}
     */
    static createVolatile() {
        const store = JDB.JungleDB.createVolatileObjectStore();
        return new AccountsTreeStore(store);
    }

    /**
     * @param {IObjectStore} store
     */
    constructor(store) {
        this._store = store;
    }

    /**
     * @override
     * @param {string} key
     * @returns {Promise.<AccountsTreeNode>}
     */
    get(key) {
        return this._store.get(key);
    }

    /**
     * @override
     * @param {AccountsTreeNode} node
     * @returns {Promise.<string>}
     */
    async put(node) {
        const key = node.prefix;
        await this._store.put(key, node);
        return key;
    }

    /**
     * @override
     * @param {AccountsTreeNode} node
     * @returns {Promise.<string>}
     */
    async remove(node) {
        const key = node.prefix;
        await this._store.remove(key);
        return key;
    }

    /**
     * @returns {Promise.<AccountsTreeNode>}
     */
    getRootNode() {
        return this.get('');
    }

    /**
     * @param startPrefix This prefix will *not* be included.
     * @param size
     * @returns {Promise.<Array.<AccountsTreeNode>>}
     */
    async getTerminalNodes(startPrefix, size) {
        const relevantKeys = [];
        await this._store.keyStream(key => {
            if (key.length === Address.HEX_SIZE) {
                relevantKeys.push(key);
                if (relevantKeys.length === size) {
                    return false;
                }
            }
            return true;
        }, true, JDB.KeyRange.lowerBound(startPrefix, true));
        const nodes = [];
        for (const key of relevantKeys) {
            nodes.push(this._store.get(key));
        }
        return Promise.all(nodes);
    }

    /**
     * @param {AccountsTreeStore} [tx]
     * @returns {AccountsTreeStore}
     */
    snapshot(tx) {
        const snapshot = this._store.snapshot();
        if (tx) {
            snapshot.inherit(tx._store);
        }
        return new AccountsTreeStore(snapshot);
    }

    /**
     * @param {boolean} [enableWatchdog]
     * @returns {AccountsTreeStore}
     */
    transaction(enableWatchdog = true) {
        const tx = this._store.transaction(enableWatchdog);
        return new AccountsTreeStore(tx);
    }

    /**
     * @returns {Promise}
     */
    truncate() {
        return this._store.truncate();
    }

    /**
     * @returns {Promise.<boolean>}
     */
    commit() {
        return this._store.commit();
    }

    /**
     * @returns {Promise}
     */
    abort() {
        return this._store.abort();
    }

    /** @type {Transaction} */
    get tx() {
        if (this._store instanceof JDB.Transaction) {
            return this._store;
        }
        return undefined;
    }
}
Class.register(AccountsTreeStore);

/**
 * @implements {ICodec}
 */
class AccountsTreeStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return obj.stripDown();
    }

    /**
     * @param {*} obj The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(obj, key) {
        return AccountsTreeNode.copy(obj);
    }

    /**
     * @type {{encode: function(val:*):*, decode: function(val:*):*, buffer: boolean, type: string}|void}
     */
    get valueEncoding() {
        return JDB.JungleDB.JSON_ENCODING;
    }
}

class AccountsProof {
    /**
     * @param {Array.<AccountsTreeNode>} nodes
     */
    constructor(nodes) {
        if (!nodes || !Array.isArray(nodes) || !NumberUtils.isUint16(nodes.length)
            || nodes.some(it => !(it instanceof AccountsTreeNode))) throw 'Malformed nodes';

        /** @type {Array.<AccountsTreeNode>} */
        this._nodes = nodes;
        /** @type {HashMap.<Hash,AccountsTreeNode>} */
        this._index = null;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsProof}
     */
    static unserialize(buf) {
        const count = buf.readUint16();
        const nodes = [];
        for (let i = 0; i < count; i++) {
            nodes.push(AccountsTreeNode.unserialize(buf));
        }
        return new AccountsProof(nodes);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._nodes.length);
        for (const node of this._nodes) {
            node.serialize(buf);
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = /*count*/ 2;
        for (const node of this._nodes) {
            size += node.serializedSize;
        }
        return size;
    }

    /**
     * Assumes nodes to be in post order and hashes nodes to check internal consistency of proof.
     * XXX Abuse this method to index the nodes contained in the proof. This forces callers to explicitly verify()
     * the proof before retrieving accounts.
     * @returns {Promise.<boolean>}
     */
    async verify() {
        /** @type {Array.<AccountsTreeNode>} */
        let children = [];
        this._index = new HashMap();
        for (const node of this._nodes) {
            // If node is a branch node, validate its children.
            if (node.isBranch()) {
                let child;
                while (child = children.pop()) { // eslint-disable-line no-cond-assign
                    if (child.isChildOf(node)) {
                        const hash = await child.hash(); // eslint-disable-line no-await-in-loop
                        // If the child is not valid, return false.
                        if (!node.getChildHash(child.prefix).equals(hash) || node.getChild(child.prefix) !== child.prefix) {
                            return false;
                        }
                        this._index.put(hash, child);
                    } else {
                        children.push(child);
                        break;
                    }
                }
            }

            // Append child.
            children.push(node);
        }

        // The last element must be the root node.
        return children.length === 1 && children[0].prefix === '' && children[0].isBranch();
    }

    /**
     * @param {Address} address
     * @returns {?Account}
     */
    getAccount(address) {
        Assert.that(!!this._index, 'AccountsProof must be verified before retrieving accounts. Call verify() first.');

        const rootNode = this._nodes[this._nodes.length - 1];
        const prefix = address.toHex();
        return this._getAccount(rootNode, prefix);
    }

    /**
     * @param {AccountsTreeNode} node
     * @param {string} prefix
     * @returns {?Account}
     * @private
     */
    _getAccount(node, prefix) {
        // Find common prefix between node and requested address.
        const commonPrefix = StringUtils.commonPrefix(node.prefix, prefix);

        // If the prefix does not fully match, the requested account does not exist.
        if (commonPrefix.length !== node.prefix.length) return null;

        // If the remaining address is empty, we have found the requested node.
        if (commonPrefix === prefix) return node.account;

        // Descend into the matching child node if one exists.
        const childKey = node.getChildHash(prefix);
        if (childKey) {
            const childNode = this._index.get(childKey);

            // If the child exists but is not part of the proof, fail.
            if (!childNode) {
                throw new Error('Requested address not part of AccountsProof');
            }

            return this._getAccount(childNode, prefix);
        }

        // No matching child exists, the requested account does not exist.
        return null;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `AccountsProof{length=${this.length}}`;
    }

    /**
     * @returns {Promise.<Hash>}
     */
    root() {
        return this._nodes[this._nodes.length - 1].hash();
    }

    /** @type {number} */
    get length() {
        return this._nodes.length;
    }

    /** @type {Array.<AccountsTreeNode>} */
    get nodes() {
        return this._nodes;
    }
}
Class.register(AccountsProof);

class AccountsTreeChunk {
    /**
     * @param {Array.<AccountsTreeNode>} nodes
     * @param {AccountsProof} proof
     */
    constructor(nodes, proof) {
        if (!nodes || !NumberUtils.isUint16(nodes.length)
            || nodes.some(it => !(it instanceof AccountsTreeNode) || !it.isTerminal())) throw 'Malformed nodes';

        /** @type {Array.<AccountsTreeNode>} */
        this._nodes = nodes;
        this._proof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsTreeChunk}
     */
    static unserialize(buf) {
        const count = buf.readUint16();
        const nodes = [];
        for (let i = 0; i < count; i++) {
            nodes.push(AccountsTreeNode.unserialize(buf));
        }
        const proof = AccountsProof.unserialize(buf);
        return new AccountsTreeChunk(nodes, proof);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._nodes.length);
        for (const node of this._nodes) {
            node.serialize(buf);
        }
        this._proof.serialize(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = /*count*/ 2;
        for (const node of this._nodes) {
            size += node.serializedSize;
        }
        size += this._proof.serializedSize;
        return size;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        if (!(await this._proof.verify())) {
            return false;
        }
        let lastPrefix = null;
        for (let i=0; i<=this._nodes.length; ++i) {
            const node = i < this._nodes.length ? this._nodes[i] : this.tail;
            if (lastPrefix && lastPrefix >= node.prefix) {
                return false;
            }
            lastPrefix = node.prefix;
        }
        return true;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `AccountsTreeChunk{length=${this.length}}`;
    }

    /**
     * @returns {Promise.<Hash>}
     */
    root() {
        return this._proof.root();
    }

    /** @type {Array.<AccountsTreeNode>} */
    get terminalNodes() {
        return this._nodes.concat([this.tail]);
    }

    /** @type {AccountsProof} */
    get proof() {
        return this._proof;
    }

    /** @type {AccountsTreeNode} */
    get head() {
        return this._nodes[0];
    }

    /** @type {AccountsTreeNode} */
    get tail() {
        return this._proof.nodes[0];
    }

    /** @type {number} */
    get length() {
        return this._nodes.length + 1;
    }
}
AccountsTreeChunk.SIZE_MAX = 1000;
AccountsTreeChunk.EMPTY = new AccountsTreeChunk([], new AccountsProof([]));
Class.register(AccountsTreeChunk);

class AccountsTree extends Observable {
    /**
     * @returns {Promise.<AccountsTree>}
     */
    static async getPersistent(jdb) {
        const store = AccountsTreeStore.getPersistent(jdb);
        const tree = new AccountsTree(store);
        return tree._init();
    }

    /**
     * @returns {Promise.<AccountsTree>}
     */
    static async createVolatile() {
        const store = AccountsTreeStore.createVolatile();
        const tree = new AccountsTree(store);
        return tree._init();
    }

    /**
     * @private
     * @param {AccountsTreeStore} store
     * @returns {AccountsTree}
     */
    constructor(store) {
        super();
        /** @type {AccountsTreeStore} */
        this._store = store;
        this._synchronizer = new Synchronizer();
    }

    /**
     * @returns {Promise.<AccountsTree>}
     * @protected
     */
    async _init() {
        let rootNode = await this._store.getRootNode();
        if (!rootNode) {
            rootNode = AccountsTreeNode.branchNode(/*prefix*/ '', /*childrenSuffixes*/ [], /*childrenHashes*/ []);
            await this._store.put(rootNode);
        }
        return this;
    }

    /**
     * @param {Address} address
     * @param {Account} account
     * @returns {Promise}
     */
    put(address, account) {
        return this._synchronizer.push(() => {
            return this._put(address, account);
        });
    }

    /**
     * @param {Address} address
     * @param {Account} account
     * @returns {Promise}
     */
    putBatch(address, account) {
        return this._synchronizer.push(() => {
            return this._putBatch(address, account);
        });
    }

    /**
     * @returns {Promise}
     */
    finalizeBatch() {
        return this._synchronizer.push(async () => {
            const rootNode = await this._store.getRootNode();
            return this._updateHashes(rootNode);
        });
    }

    /**
     * @param {Address} address
     * @param {Account} account
     * @returns {Promise}
     * @private
     */
    async _putBatch(address, account) {
        if (account.isInitial() && !(await this.get(address))) {
            return;
        }

        // Fetch the root node.
        const rootNode = await this._store.getRootNode();
        Assert.that(!!rootNode, 'Corrupted store: Failed to fetch AccountsTree root node');

        // Insert account into the tree at address.
        const prefix = address.toHex();
        await this._insertBatch(rootNode, prefix, account, []);
    }

    /**
     * @param {AccountsTreeNode} node
     * @param {string} prefix
     * @param {Account} account
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @protected
     */
    async _insertBatch(node, prefix, account, rootPath) {
        // Find common prefix between node and new address.
        const commonPrefix = StringUtils.commonPrefix(node.prefix, prefix);

        // If the node prefix does not fully match the new address, split the node.
        if (commonPrefix.length !== node.prefix.length) {
            // Insert the new account node.
            const newChild = AccountsTreeNode.terminalNode(prefix, account);
            await this._store.put(newChild);

            // Insert the new parent node.
            const newParent = AccountsTreeNode.branchNode(commonPrefix)
                .withChild(node.prefix, new Hash(null))
                .withChild(newChild.prefix, new Hash(null));
            await this._store.put(newParent);

            return this._updateKeysBatch(newParent.prefix, rootPath);
        }

        // If the commonPrefix is the specified address, we have found an (existing) node
        // with the given address. Update the account.
        if (commonPrefix === prefix) {
            // XXX How does this generalize to more than one account type?
            // Special case: If the new balance is the initial balance
            // (i.e. balance=0, nonce=0), it is like the account never existed
            // in the first place. Delete the node in this case.
            if (account.isInitial()) {
                await this._store.remove(node);
                // We have already deleted the node, remove the subtree it was on.
                return this._pruneBatch(node.prefix, rootPath);
            }

            // Update the account.
            node = node.withAccount(account);
            await this._store.put(node);

            return this._updateKeysBatch(node.prefix, rootPath);
        }

        // If the node prefix matches and there are address bytes left, descend into
        // the matching child node if one exists.
        const childPrefix = node.getChild(prefix);
        if (childPrefix) {
            const childNode = await this._store.get(childPrefix);
            rootPath.push(node);
            return this._insertBatch(childNode, prefix, account, rootPath);
        }

        // If no matching child exists, add a new child account node to the current node.
        const newChild = AccountsTreeNode.terminalNode(prefix, account);
        await this._store.put(newChild);

        node = node.withChild(newChild.prefix, new Hash(null));
        await this._store.put(node);

        return this._updateKeysBatch(node.prefix, rootPath);
    }

    /**
     * @param {string} prefix
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @private
     */
    async _pruneBatch(prefix, rootPath) {
        // Walk along the rootPath towards the root node starting with the
        // immediate predecessor of the node specified by 'prefix'.
        let i = rootPath.length - 1;
        for (; i >= 0; --i) {
            let node = rootPath[i];

            node = node.withoutChild(prefix);

            // If the node has only a single child, merge it with the next node.
            if (node.hasSingleChild() && node.prefix !== '') {
                await this._store.remove(node); // eslint-disable-line no-await-in-loop

                const childPrefix = node.getFirstChild();
                const childNode = await this._store.get(childPrefix); // eslint-disable-line no-await-in-loop

                await this._store.put(childNode); // eslint-disable-line no-await-in-loop
                return this._updateKeysBatch(childNode.prefix, rootPath.slice(0, i));
            }
            // Otherwise, if the node has children left, update it and all keys on the
            // remaining root path. Pruning finished.
            // XXX Special case: We start with an empty root node. Don't delete it.
            else if (node.hasChildren() || node.prefix === '') {
                await this._store.put(node); // eslint-disable-line no-await-in-loop
                return this._updateKeysBatch(node.prefix, rootPath.slice(0, i));
            }

            // The node has no children left, continue pruning.
            prefix = node.prefix;
        }

        // XXX This should never be reached.
        return undefined;
    }

    /**
     * @param {string} prefix
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @private
     */
    async _updateKeysBatch(prefix, rootPath) {
        // Walk along the rootPath towards the root node starting with the
        // immediate predecessor of the node specified by 'prefix'.
        let i = rootPath.length - 1;
        for (; i >= 0; --i) {
            let node = rootPath[i];

            node = node.withChild(prefix, new Hash(null));
            await this._store.put(node); // eslint-disable-line no-await-in-loop
            prefix = node.prefix;
        }
    }

    /**
     * This method updates all empty hashes (and only such).
     * @param {AccountsTreeNode} node
     * @protected
     */
    async _updateHashes(node) {
        if (node.isTerminal()) {
            return node.hash();
        }
        const zeroHash = new Hash(null);
        // Compute sub hashes if necessary.
        const subHashes = await Promise.all(node.getChildren().map(async child => {
            const currentHash = node.getChildHash(child);
            if (!currentHash.equals(zeroHash)) {
                return currentHash;
            }
            const childNode = await this._store.get(child);
            return this._updateHashes(childNode);
        }));
        // Then prepare new node and update.
        let newNode = node;
        node.getChildren().forEach((child, i) => {
            newNode = newNode.withChild(child, subHashes[i]);
        });
        await this._store.put(newNode);
        return newNode.hash();
    }

    /**
     * @param {Address} address
     * @param {Account} account
     * @returns {Promise}
     * @private
     */
    async _put(address, account) {
        if (account.isInitial() && !(await this.get(address))) {
            return;
        }

        // Fetch the root node.
        const rootNode = await this._store.getRootNode();
        Assert.that(!!rootNode, 'Corrupted store: Failed to fetch AccountsTree root node');

        // Insert account into the tree at address.
        const prefix = address.toHex();
        await this._insert(rootNode, prefix, account, []);
    }

    /**
     * @param {AccountsTreeNode} node
     * @param {string} prefix
     * @param {Account} account
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @private
     */
    async _insert(node, prefix, account, rootPath) {
        // Find common prefix between node and new address.
        const commonPrefix = StringUtils.commonPrefix(node.prefix, prefix);

        // If the node prefix does not fully match the new address, split the node.
        if (commonPrefix.length !== node.prefix.length) {
            // Insert the new account node.
            const newChild = AccountsTreeNode.terminalNode(prefix, account);
            const newChildHash = await newChild.hash();
            await this._store.put(newChild);

            // Insert the new parent node.
            const newParent = AccountsTreeNode.branchNode(commonPrefix)
                .withChild(node.prefix, await node.hash())
                .withChild(newChild.prefix, newChildHash);
            const newParentHash = await newParent.hash();
            await this._store.put(newParent);

            return this._updateKeys(newParent.prefix, newParentHash, rootPath);
        }

        // If the commonPrefix is the specified address, we have found an (existing) node
        // with the given address. Update the account.
        if (commonPrefix === prefix) {
            // XXX How does this generalize to more than one account type?
            // Special case: If the new balance is the initial balance
            // (i.e. balance=0, nonce=0), it is like the account never existed
            // in the first place. Delete the node in this case.
            if (account.isInitial()) {
                await this._store.remove(node);
                // We have already deleted the node, remove the subtree it was on.
                return this._prune(node.prefix, rootPath);
            }

            // Update the account.
            node = node.withAccount(account);
            const nodeHash = await node.hash();
            await this._store.put(node);

            return this._updateKeys(node.prefix, nodeHash, rootPath);
        }

        // If the node prefix matches and there are address bytes left, descend into
        // the matching child node if one exists.
        const childPrefix = node.getChild(prefix);
        if (childPrefix) {
            const childNode = await this._store.get(childPrefix);
            rootPath.push(node);
            return this._insert(childNode, prefix, account, rootPath);
        }

        // If no matching child exists, add a new child account node to the current node.
        const newChild = AccountsTreeNode.terminalNode(prefix, account);
        const newChildHash = await newChild.hash();
        await this._store.put(newChild);

        node = node.withChild(newChild.prefix, newChildHash);
        const nodeHash = await node.hash();
        await this._store.put(node);

        return this._updateKeys(node.prefix, nodeHash, rootPath);
    }

    /**
     * @param {string} prefix
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @private
     */
    async _prune(prefix, rootPath) {
        // Walk along the rootPath towards the root node starting with the
        // immediate predecessor of the node specified by 'prefix'.
        let i = rootPath.length - 1;
        for (; i >= 0; --i) {
            let node = rootPath[i];

            node = node.withoutChild(prefix);

            // If the node has only a single child, merge it with the next node.
            if (node.hasSingleChild() && node.prefix !== '') {
                await this._store.remove(node); // eslint-disable-line no-await-in-loop

                const childPrefix = node.getFirstChild();
                const childNode = await this._store.get(childPrefix); // eslint-disable-line no-await-in-loop

                await this._store.put(childNode); // eslint-disable-line no-await-in-loop
                const childHash = await childNode.hash();
                return this._updateKeys(childNode.prefix, childHash, rootPath.slice(0, i));
            }
            // Otherwise, if the node has children left, update it and all keys on the
            // remaining root path. Pruning finished.
            // XXX Special case: We start with an empty root node. Don't delete it.
            else if (node.hasChildren() || node.prefix === '') {
                const nodeHash = await node.hash();
                await this._store.put(node); // eslint-disable-line no-await-in-loop
                return this._updateKeys(node.prefix, nodeHash, rootPath.slice(0, i));
            }

            // The node has no children left, continue pruning.
            prefix = node.prefix;
        }

        // XXX This should never be reached.
        return undefined;
    }

    /**
     * @param {string} prefix
     * @param {Hash} nodeHash
     * @param {Array.<AccountsTreeNode>} rootPath
     * @returns {Promise}
     * @private
     */
    async _updateKeys(prefix, nodeHash, rootPath) {
        // Walk along the rootPath towards the root node starting with the
        // immediate predecessor of the node specified by 'prefix'.
        let i = rootPath.length - 1;
        for (; i >= 0; --i) {
            let node = rootPath[i];

            node = node.withChild(prefix, nodeHash);
            await this._store.put(node); // eslint-disable-line no-await-in-loop
            nodeHash = await node.hash(); // eslint-disable-line no-await-in-loop
            prefix = node.prefix;
        }

        return nodeHash;
    }

    /**
     * @param {Address} address
     * @returns {Promise.<?Account>}
     */
    async get(address) {
        const node = await this._store.get(address.toHex());
        return node !== undefined ? node.account : null;
    }

    /**
     * @param {Array.<Address>} addresses
     * @returns {Promise.<AccountsProof>}
     */
    async getAccountsProof(addresses) {
        const rootNode = await this._store.getRootNode();
        Assert.that(!!rootNode, 'Corrupted store: Failed to fetch AccountsTree root node');

        const prefixes = [];
        for (const address of addresses) {
            prefixes.push(address.toHex());
        }
        // We sort the addresses to simplify traversal in post order (leftmost addresses first).
        prefixes.sort();

        const nodes = [];
        await this._getAccountsProof(rootNode, prefixes, nodes);
        return new AccountsProof(nodes);
    }

    /**
     * Constructs the accounts proof in post-order.
     * @param {AccountsTreeNode} node
     * @param {Array.<string>} prefixes
     * @param {Array.<AccountsTreeNode>} nodes
     * @returns {Promise.<*>}
     * @private
     */
    async _getAccountsProof(node, prefixes, nodes) {
        // For each prefix, descend the tree individually.
        let includeNode = false;
        for (let i = 0; i < prefixes.length; ) {
            let prefix = prefixes[i];

            // Find common prefix between node and the current requested prefix.
            const commonPrefix = StringUtils.commonPrefix(node.prefix, prefix);

            // If the prefix fully matches, we have found the requested node.
            // If the prefix does not fully match, the requested address is not part of this node.
            // Include the node in the proof nevertheless to prove that the account doesn't exist.
            if (commonPrefix.length !== node.prefix.length || node.prefix === prefix) {
                includeNode = true;
                i++;
                continue;
            }

            // Descend into the matching child node if one exists.
            const childKey = node.getChild(prefix);
            if (childKey) {
                const childNode = await this._store.get(childKey); // eslint-disable-line no-await-in-loop

                // Group addresses with same prefix:
                // Because of our ordering, they have to be located next to the current prefix.
                // Hence, we iterate over the next prefixes, until we don't find commonalities anymore.
                // In the next main iteration we can skip those we already requested here.
                const subPrefixes = [prefix];
                // Find other prefixes to descend into this tree as well.
                let j = i + 1;
                for (; j < prefixes.length; ++j) {
                    // Since we ordered prefixes, there can't be any other prefixes with commonalities.
                    if (!prefixes[j].startsWith(childNode.prefix)) break;
                    // But if there is a commonality, add it to the list.
                    subPrefixes.push(prefixes[j]);
                }
                // Now j is the last index which doesn't have commonalities,
                // we continue from there in the next iteration.
                i = j;

                includeNode = (await this._getAccountsProof(childNode, subPrefixes, nodes)) || includeNode; // eslint-disable-line no-await-in-loop
            }
            // No child node exists with the requested prefix. Include the current node to prove the absence of the requested account.
            else {
                includeNode = true;
                i++;
            }
        }

        // If this branch contained at least one account, we add this node.
        if (includeNode) {
            nodes.push(node);
        }

        return includeNode;
    }

    /**
     * @param {string} startPrefix The prefix to start with.
     * @param {number} size The maximum number of terminal nodes to include.
     * @returns {Promise.<AccountsTreeChunk>}
     */
    async getChunk(startPrefix, size) {
        const chunk = await this._store.getTerminalNodes(startPrefix, size);
        const lastNode = chunk.pop();
        let /** @type {AccountsProof} */ proof;
        if (lastNode) {
            proof = await this.getAccountsProof([Address.fromHex(lastNode.prefix)]);
        } else {
            // The proof that the last address does not exist is suitable to proof there is no such chunk.
            proof = await this.getAccountsProof([Address.fromHex('ffffffffffffffffffffffffffffffffffffffff')]);
        }
        return new AccountsTreeChunk(chunk, proof);
    }

    /**
     * @param {boolean} [enableWatchdog]
     * @returns {Promise.<AccountsTree>}
     */
    transaction(enableWatchdog = true) {
        const tree = new AccountsTree(this._store.transaction(enableWatchdog));
        return tree._init();
    }

    /**
     * @returns {Promise.<PartialAccountsTree>}
     */
    async partialTree() {
        const tx = this._store.transaction(false);
        await tx.truncate();
        const tree = new PartialAccountsTree(tx);
        return tree._init();
    }

    /**
     * @param {AccountsTree} [tx]
     * @returns {Promise.<AccountsTree>}
     */
    snapshot(tx) {
        const tree = new AccountsTree(this._store.snapshot(tx ? tx._store : undefined));
        return tree._init();
    }

    /**
     * @returns {Promise}
     */
    async commit() {
        Assert.that(!(await this.root()).equals(new Hash(null)));
        return this._store.commit();
    }

    /**
     * @returns {Promise}
     */
    abort() {
        return this._store.abort();
    }

    /**
     * @returns {Promise.<Hash>}
     */
    async root() {
        const rootNode = await this._store.getRootNode();
        return rootNode && rootNode.hash();
    }

    /** @type {Transaction} */
    get tx() {
        return this._store.tx;
    }
}
Class.register(AccountsTree);


class PartialAccountsTree extends AccountsTree {
    /**
     * @private
     * @param {AccountsTreeStore} store
     */
    constructor(store) {
        super(store);
        this._complete = false;
        /** @type {string} */
        this._lastPrefix = '';
    }

    /**
     * @param {AccountsTreeChunk} chunk
     * @returns {Promise.<PartialAccountsTree.Status>}
     */
    async pushChunk(chunk) {
        // First verify the proof.
        if (!(await chunk.verify())) {
            return PartialAccountsTree.Status.ERR_INCORRECT_PROOF;
        }

        const tx = await this.transaction();
        // Then apply all
        await tx._putLight(chunk.terminalNodes);


        // Check if proof can be merged.
        if (!(await tx._mergeProof(chunk.proof, chunk.tail.prefix))) {
            await tx.abort();
            return PartialAccountsTree.Status.ERR_UNMERGEABLE;
        }
        this._complete = tx.complete;

        // Now, we can put all nodes into the store.
        await tx.commit();

        // Update last prefix.
        this._lastPrefix = chunk.tail.prefix;

        // And return OK code depending on internal state.
        return this._complete ? PartialAccountsTree.Status.OK_COMPLETE : PartialAccountsTree.Status.OK_UNFINISHED;
    }

    /**
     * @param {AccountsProof} proof
     * @param {string} upperBound
     * @returns {Promise.<boolean>}
     * @private
     */
    async _mergeProof(proof, upperBound) {
        // Retrieve rightmost path of the in-memory tree.
        let node = await this._store.getRootNode();
        let nodeChildren = node.getChildren();
        let complete = true;

        // Iterate over the proof and check for consistency.
        let j = proof.length - 1;
        for (; j > 0; --j) {
            const proofNode = proof.nodes[j];
            // The node's prefix might be shorter than the proof node's prefix if it is a newly
            // introduces node in the proof.
            if (StringUtils.commonPrefix(node.prefix, proofNode.prefix) !== node.prefix) {
                return false;
            }

            const proofChildren = proofNode.getChildren();

            // The tree node may not have more children than the proof node.
            if (nodeChildren.length > proofChildren.length) {
                return false;
            }

            // The nextChild we descend to.
            const nextChild = node.getLastChild();
            let insertedNode = false;

            // There are three cases:
            // 1) the child is in our inner tree (so between lower and upper bound), then the hashes must coincide.
            // 2) the child is left of our chunk, so it must be in the store.
            // 3) the child is right of our chunk, so it is a dangling reference.
            let i = 0;
            for (const proofChild of proofChildren) {
                const upperBoundPrefix = upperBound.substr(0, proofChild.length);
                if (proofChild <= upperBoundPrefix) {
                    // An inner node.
                    const child = nodeChildren.shift();

                    // This is the next child.
                    if (StringUtils.commonPrefix(nextChild, proofChild) === proofChild) {
                        // If it is a real prefix of the next child, we have inserted a new node.
                        if (proofChild !== nextChild) {
                            insertedNode = true;
                        }
                        continue;
                    }

                    if (child !== proofChild) {
                        return false;
                    }
                    // The child is equal and not the next child, so the hash must coincide.
                    const nodeHash = node.getChildHash(child);
                    const proofHash = proofNode.getChildHash(child);
                    if (!nodeHash || !proofHash || !nodeHash.equals(proofHash)) {
                        return false;
                    }
                } else {
                    // The others may be dangling references.
                    break;
                }
                ++i;
            }

            // We must have consumed all children!
            if (nodeChildren.length !== 0) {
                return false;
            }

            // If not all of the proof children have been tested, we are definitely incomplete.
            complete = complete && (i === proofChildren.length - 1);

            // If the prefix was the same, we can move on.
            if (insertedNode) {
                nodeChildren = [nextChild];
            } else {
                // We should never end here with a terminal node.
                if (node.isTerminal()) {
                    return false;
                }
                node = await this._store.get(node.getLastChild());
                nodeChildren = node.getChildren();
                if (node.isTerminal()) {
                    break;
                }
            }
        }

        // Check the terminal nodes.
        if (!node.equals(proof.nodes[0])) {
            return false;
        }

        this._complete = complete;
        return true;
    }

    /**
     * @param {Array.<AccountsTreeNode>} nodes
     * @returns {Promise}
     * @private
     */
    async _putLight(nodes) {
        Assert.that(nodes.every(node => node.isTerminal()), 'Can only build tree from terminal nodes');

        // Fetch the root node.
        let rootNode = await this._store.getRootNode();
        Assert.that(!!rootNode, 'Corrupted store: Failed to fetch AccountsTree root node');

        // TODO: Bulk insertion instead of sequential insertion!
        for (const node of nodes) {
            await this._insertBatch(rootNode, node.prefix, node.account, []);
            rootNode = await this._store.getRootNode();
            Assert.that(!!rootNode, 'Corrupted store: Failed to fetch AccountsTree root node');
        }
        await this._updateHashes(rootNode);
    }

    /** @type {boolean} */
    get complete() {
        return this._complete;
    }

    /** @type {string} */
    get missingPrefix() {
        return this._lastPrefix;
    }

    /**
     * @param {boolean} [enableWatchdog]
     * @returns {Promise.<PartialAccountsTree>}
     */
    transaction(enableWatchdog=true) {
        const tree = new PartialAccountsTree(this._store.transaction(enableWatchdog));
        tree._complete = this._complete;
        tree._lastPrefix = this._lastPrefix;
        return tree._init();
    }

    /**
     * @returns {Promise.<boolean>}
     */
    commit() {
        return this._store.commit();
    }

    /**
     * @returns {Promise}
     */
    abort() {
        return this._store.abort();
    }
}

/**
 * @enum {number}
 */
PartialAccountsTree.Status = {
    ERR_HASH_MISMATCH: -3,
    ERR_INCORRECT_PROOF: -2,
    ERR_UNMERGEABLE: -1,
    OK_COMPLETE: 0,
    OK_UNFINISHED: 1
};
Class.register(PartialAccountsTree);


class Accounts extends Observable {
    /**
     * Generate an Accounts object that is persisted to the local storage.
     * @returns {Promise.<Accounts>} Accounts object
     */
    static async getPersistent(jdb) {
        const tree = await AccountsTree.getPersistent(jdb);
        return new Accounts(tree);
    }

    /**
     * Generate an Accounts object that loses it's data after usage.
     * @returns {Promise.<Accounts>} Accounts object
     */
    static async createVolatile() {
        const tree = await AccountsTree.createVolatile();
        return new Accounts(tree);
    }

    /**
     * @param {AccountsTree} accountsTree
     */
    constructor(accountsTree) {
        super();
        this._tree = accountsTree;

        // Forward balance change events to listeners registered on this Observable.
        this.bubble(this._tree, '*');
    }

    /**
     * @param {Array.<Address>} addresses
     * @returns {Promise.<AccountsProof>}
     */
    getAccountsProof(addresses) {
        return this._tree.getAccountsProof(addresses);
    }

    /**
     * @param {string} startPrefix
     * @returns {Promise.<AccountsTreeChunk>}
     */
    getAccountsTreeChunk(startPrefix) {
        return this._tree.getChunk(startPrefix, AccountsTreeChunk.SIZE_MAX);
    }

    /**
     * @param {Block} block
     * @return {Promise}
     */
    async commitBlock(block) {
        const tree = await this._tree.transaction();
        try {
            await this._commitBlockBody(tree, block.body, block.height);
        } catch (e) {
            await tree.abort();
            throw e;
        }

        await tree.finalizeBatch();

        const hash = await tree.root();
        if (!block.accountsHash.equals(hash)) {
            await tree.abort();
            throw new Error('AccountsHash mismatch');
        }
        return tree.commit();
    }

    /**
     * @param {BlockBody} body
     * @param {number} blockHeight
     * @return {Promise}
     */
    async commitBlockBody(body, blockHeight) {
        const tree = await this._tree.transaction();
        try {
            await this._commitBlockBody(tree, body, blockHeight);
        } catch (e) {
            await tree.abort();
            throw e;
        }
        await tree.finalizeBatch();
        return tree.commit();
    }

    /**
     * @param {Block} block
     * @return {Promise}
     */
    async revertBlock(block) {
        if (!block) throw new Error('block undefined');

        const hash = await this._tree.root();
        if (!block.accountsHash.equals(hash)) {
            throw new Error('AccountsHash mismatch');
        }
        return this.revertBlockBody(block.body, block.height);
    }

    /**
     * @param {BlockBody} body
     * @param {number} blockHeight
     * @return {Promise}
     */
    async revertBlockBody(body, blockHeight) {
        const tree = await this._tree.transaction();
        try {
            await this._revertBlockBody(tree, body, blockHeight);
        } catch (e) {
            await tree.abort();
            throw e;
        }
        await tree.finalizeBatch();
        return tree.commit();
    }

    /**
     * Gets the {@link Account}-object for an address.
     *
     * @param {Address} address
     * @param {Account.Type} [accountType]
     * @param {AccountsTree} [tree]
     * @return {Promise.<Account>}
     */
    async get(address, accountType, tree = this._tree) {
        const account = await tree.get(address);
        if (!account) {
            if (typeof accountType === 'undefined') {
                return null;
            }
            if (!Account.TYPE_MAP.has(accountType)) {
                throw new Error('Invalid account type');
            }
            return Account.TYPE_MAP.get(accountType).INITIAL;
        } else if (typeof accountType !== 'undefined' && account.type !== accountType) {
            throw new Error('Account type does match actual account');
        }
        return account;
    }

    /**
     * @param {boolean} [enableWatchdog]
     * @returns {Promise.<Accounts>}
     */
    async transaction(enableWatchdog = true) {
        return new Accounts(await this._tree.transaction(enableWatchdog));
    }

    /**
     * @param {Accounts} [tx]
     * @returns {Promise.<Accounts>}
     */
    async snapshot(tx) {
        return new Accounts(await this._tree.snapshot(tx ? tx._tree : undefined));
    }

    /**
     * @returns {Promise.<PartialAccountsTree>}
     */
    async partialAccountsTree() {
        return this._tree.partialTree();
    }

    /**
     * @returns {Promise}
     */
    commit() {
        return this._tree.commit();
    }

    /**
     * @returns {Promise}
     */
    abort() {
        return this._tree.abort();
    }

    /**
     * @param {AccountsTree} tree
     * @param {BlockBody} body
     * @param {number} blockHeight
     * @return {Promise.<void>}
     * @private
     */
    async _commitBlockBody(tree, body, blockHeight) {
        for (const tx of body.transactions.slice().sort((a, b) => a.compareAccountOrder(b))) {
            await this._executeTransaction(tree, tx, blockHeight, false);
        }

        await this._rewardMiner(tree, body, blockHeight, false);
    }

    /**
     * @param {AccountsTree} tree
     * @param {BlockBody} body
     * @param {number} blockHeight
     * @return {Promise.<void>}
     * @private
     */
    async _revertBlockBody(tree, body, blockHeight) {
        // Execute transactions in reverse order.
        for (const tx of body.transactions.slice().sort((a, b) => a.compareAccountOrder(b)).reverse()) {
            await this._executeTransaction(tree, tx, blockHeight, true);
        }

        await this._rewardMiner(tree, body, blockHeight, true);
    }

    /**
     * @param {AccountsTree} tree
     * @param {BlockBody} body
     * @param {number} blockHeight
     * @param {boolean} [revert]
     * @return {Promise.<void>}
     * @private
     */
    async _rewardMiner(tree, body, blockHeight, revert = false) {
        // Sum up transaction fees.
        const txFees = body.transactions.reduce((sum, tx) => sum + tx.fee, 0);

        // "Coinbase transaction"
        const coinbaseSender = new Address(new Uint8Array(Address.SERIALIZED_SIZE));
        const coinbaseTransaction = new ExtendedTransaction(coinbaseSender, Account.Type.BASIC, body.minerAddr, Account.Type.BASIC, txFees + Policy.blockRewardAt(blockHeight), 0, 0, new Uint8Array(0));

        const recipientAccount = await this.get(body.minerAddr, undefined, tree) || BasicAccount.INITIAL;
        await tree.putBatch(body.minerAddr, recipientAccount.withIncomingTransaction(coinbaseTransaction, blockHeight, revert));
    }

    /**
     * @param {AccountsTree} tree
     * @param {Transaction} tx
     * @param {number} blockHeight
     * @param {boolean} revert
     * @returns {Promise.<void>}
     * @private
     */
    async _executeTransaction(tree, tx, blockHeight, revert) {
        const senderAccount = await this.get(tx.sender, tx.senderType, tree);
        const recipientAccount = await this.get(tx.recipient, tx.recipientType, tree);
        await tree.putBatch(tx.sender, senderAccount.withOutgoingTransaction(tx, blockHeight, revert));
        await tree.putBatch(tx.recipient, recipientAccount.withIncomingTransaction(tx, blockHeight, revert));
    }

    /**
     * @param {AccountsTree} tree
     * @param {Address} address
     * @param {number} value
     * @returns {Promise.<void>}
     * @deprecated
     * @private
     */
    async _addBalance(tree, address, value) {
        const account = await this.get(address, undefined, tree) || BasicAccount.INITIAL;
        await tree.putBatch(address, account.withBalance(account.balance + value));
    }

    /**
     * @returns {Promise.<Hash>}
     */
    hash() {
        return this._tree.root();
    }

    /** @type {Transaction} */
    get tx() {
        return this._tree.tx;
    }
}

Accounts.EMPTY_TREE_HASH = Hash.fromBase64('qynm3BZ1XQBx66NJ69oiXRXk+RDLR0VJxH6Vy4XsxNY=');
Class.register(Accounts);

class BlockHeader {
    /**
     * @param {BlockHeader} o
     * @returns {BlockHeader}
     */
    static copy(o) {
        if (!o) return o;
        const prevHash = Hash.copy(o._prevHash);
        const interlinkHash = Hash.copy(o._interlinkHash);
        const bodyHash = Hash.copy(o._bodyHash);
        const accountsHash = Hash.copy(o._accountsHash);
        return new BlockHeader(
            prevHash, interlinkHash, bodyHash, accountsHash,
            o._nBits, o._height, o._timestamp, o._nonce, o._version
        );
    }

    /**
     * @param {Hash} prevHash
     * @param {Hash} interlinkHash
     * @param {Hash} bodyHash
     * @param {Hash} accountsHash
     * @param {number} nBits
     * @param {number} height
     * @param {number} timestamp
     * @param {number} nonce
     * @param {number} version
     */
    constructor(prevHash, interlinkHash, bodyHash, accountsHash, nBits, height, timestamp, nonce, version = BlockHeader.CURRENT_VERSION) {
        if (!NumberUtils.isUint16(version)) throw 'Malformed version';
        if (!Hash.isHash(prevHash)) throw 'Malformed prevHash';
        if (!Hash.isHash(interlinkHash)) throw 'Malformed interlinkHash';
        if (!Hash.isHash(bodyHash)) throw 'Malformed bodyHash';
        if (!Hash.isHash(accountsHash)) throw 'Malformed accountsHash';
        if (!NumberUtils.isUint32(nBits) || !BlockUtils.isValidCompact(nBits)) throw 'Malformed nBits';
        if (!NumberUtils.isUint32(height)) throw 'Invalid height';
        if (!NumberUtils.isUint32(timestamp)) throw 'Malformed timestamp';
        if (!NumberUtils.isUint32(nonce)) throw 'Malformed nonce';

        /** @type {number} */
        this._version = version;
        /** @type {Hash} */
        this._prevHash = prevHash;
        /** @type {Hash} */
        this._interlinkHash = interlinkHash;
        /** @type {Hash} */
        this._bodyHash = bodyHash;
        /** @type {Hash} */
        this._accountsHash = accountsHash;
        /** @type {number} */
        this._nBits = nBits;
        /** @type {number} */
        this._height = height;
        /** @type {number} */
        this._timestamp = timestamp;
        /** @type {number} */
        this._nonce = nonce;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {BlockHeader}
     */
    static unserialize(buf) {
        const version = buf.readUint16();
        if (!BlockHeader.SUPPORTED_VERSIONS.includes(version)) throw 'Block version unsupported';
        const prevHash = Hash.unserialize(buf);
        const interlinkHash = Hash.unserialize(buf);
        const bodyHash = Hash.unserialize(buf);
        const accountsHash = Hash.unserialize(buf);
        const nBits = buf.readUint32();
        const height = buf.readUint32();
        const timestamp = buf.readUint32();
        const nonce = buf.readUint32();
        return new BlockHeader(prevHash, interlinkHash, bodyHash, accountsHash, nBits, height, timestamp, nonce, version);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._version);
        this._prevHash.serialize(buf);
        this._interlinkHash.serialize(buf);
        this._bodyHash.serialize(buf);
        this._accountsHash.serialize(buf);
        buf.writeUint32(this._nBits);
        buf.writeUint32(this._height);
        buf.writeUint32(this._timestamp);
        buf.writeUint32(this._nonce);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*version*/ 2
            + this._prevHash.serializedSize
            + this._interlinkHash.serializedSize
            + this._bodyHash.serializedSize
            + this._accountsHash.serializedSize
            + /*nBits*/ 4
            + /*height*/ 4
            + /*timestamp*/ 4
            + /*nonce*/ 4;
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {Promise.<boolean>}
     */
    async verifyProofOfWork(buf) {
        const pow = await this.pow(buf);
        return BlockUtils.isProofOfWork(pow, this.target);
    }

    /**
     * @param {BlockHeader} prevHeader
     * @returns {Promise.<boolean>}
     */
    async isImmediateSuccessorOf(prevHeader) {
        // Check that the height is one higher than the previous height.
        if (this.height !== prevHeader.height + 1) {
            return false;
        }

        // Check that the timestamp is greater or equal to the predecessor's timestamp.
        if (this.timestamp < prevHeader.timestamp) {
            return false;
        }

        // Check that the hash of the predecessor block equals prevHash.
        const prevHash = await prevHeader.hash();
        if (!this.prevHash.equals(prevHash)) {
            return false;
        }

        // Check that the target adjustment between the blocks does not exceed the theoretical limit.
        const adjustmentFactor = this.target / prevHeader.target;
        if (adjustmentFactor > Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR
            || adjustmentFactor < 1 / Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR) {
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {Promise.<Hash>}
     */
    async hash(buf) {
        this._hash = this._hash || await Hash.light(this.serialize(buf));
        return this._hash;
    }
    
    /**
     * @param {SerialBuffer} [buf]
     * @return {Promise.<Hash>}
     */
    async pow(buf) {
        this._pow = this._pow || await Hash.hard(this.serialize(buf));
        return this._pow;
    }

    /**
     * @param {BlockHeader|*} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof BlockHeader
            && this._prevHash.equals(o.prevHash)
            && this._interlinkHash.equals(o.interlinkHash)
            && this._bodyHash.equals(o.bodyHash)
            && this._accountsHash.equals(o.accountsHash)
            && this._nBits === o.nBits
            && this._height === o.height
            && this._timestamp === o.timestamp
            && this._nonce === o.nonce;
    }

    /**
     * @returns {string}
     */
    toString() {
        return 'BlockHeader{'
            + `prevHash=${this._prevHash}, `
            + `interlinkHash=${this._interlinkHash}, `
            + `bodyHash=${this._bodyHash}, `
            + `accountsHash=${this._accountsHash}, `
            + `nBits=${this._nBits.toString(16)}, `
            + `height=${this._height}, `
            + `timestamp=${this._timestamp}, `
            + `nonce=${this._nonce}`
            + '}';
    }

    /** @type {number} */
    get version() {
        return this._version;
    }

    /** @type {Hash} */
    get prevHash() {
        return this._prevHash;
    }

    /** @type {Hash} */
    get interlinkHash() {
        return this._interlinkHash;
    }

    /** @type {Hash} */
    get bodyHash() {
        return this._bodyHash;
    }

    /** @type {Hash} */
    get accountsHash() {
        return this._accountsHash;
    }

    /** @type {number} */
    get nBits() {
        return this._nBits;
    }

    /** @type {number} */
    get target() {
        return BlockUtils.compactToTarget(this._nBits);
    }

    /** @type {number} */
    get difficulty() {
        return BlockUtils.compactToDifficulty(this._nBits);
    }

    /** @type {number} */
    get height() {
        return this._height;
    }

    /** @type {number} */
    get timestamp() {
        return this._timestamp;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }

    // XXX The miner changes the nonce of an existing BlockHeader during the
    // mining process.
    /** @type {number} */
    set nonce(n) {
        this._nonce = n;
        this._hash = null;
        this._pow = null;
    }
}
// FIXME: Clean up for mainnet.
BlockHeader.Version = {
    LUNA_V1: 1,
    LUNA_V2: 2
};
BlockHeader.CURRENT_VERSION = BlockHeader.Version.LUNA_V2;
BlockHeader.SUPPORTED_VERSIONS = [
    BlockHeader.Version.LUNA_V1,
    BlockHeader.Version.LUNA_V2
];
BlockHeader.SERIALIZED_SIZE = 146;
Class.register(BlockHeader);

class BlockInterlink {
    /**
     * @param {BlockInterlink} o
     * @returns {BlockInterlink}
     */
    static copy(o) {
        if (!o) return o;
        const hashes = o._hashes.map(it => Hash.copy(it));
        return new BlockInterlink(hashes);
    }

    /**
     * @param {Array.<Hash>} hashes
     * @returns {{repeatBits: Uint8Array, compressed: Array.<Hash>}}
     * @private
     */
    static _compress(hashes) {
        const count = hashes.length;
        const repeatBitsSize = Math.ceil(count / 8);
        const repeatBits = new Uint8Array(repeatBitsSize);

        let lastHash = null;
        const compressed = [];
        for (let i = 0; i < count; i++) {
            const hash = hashes[i];
            if (!hash.equals(lastHash)) {
                compressed.push(hash);
                lastHash = hash;
            } else {
                repeatBits[Math.floor(i / 8)] |= 0x80 >>> (i % 8);
            }
        }

        return {repeatBits, compressed};
    }

    /**
     * @param {Array.<Hash>} blockHashes
     * @param {Uint8Array} [repeatBits]
     * @param {Array.<Hash>} [compressed]
     */
    constructor(blockHashes, repeatBits, compressed) {
        if (!Array.isArray(blockHashes) || !NumberUtils.isUint8(blockHashes.length)
            || blockHashes.some(it => !(it instanceof Hash))) throw 'Malformed blockHashes';
        if ((repeatBits || compressed) && !(repeatBits && compressed)) throw 'Malformed repeatBits/compressed';

        if (!repeatBits) {
            ({repeatBits, compressed} = BlockInterlink._compress(blockHashes));
        }

        /** @type {Array.<Hash>} */
        this._hashes = blockHashes;
        /** @type {Uint8Array} */
        this._repeatBits = repeatBits;
        /** @type {Array.<Hash>} */
        this._compressed = compressed;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {BlockInterlink}
     */
    static unserialize(buf) {
        const count = buf.readUint8();
        const repeatBitsSize = Math.ceil(count / 8);
        const repeatBits = buf.read(repeatBitsSize);

        let hash = null;
        const hashes = [];
        const compressed = [];
        for (let i = 0; i < count; i++) {
            const repeated = (repeatBits[Math.floor(i / 8)] & (0x80 >>> (i % 8))) !== 0;
            if (!repeated || !hash) {
                hash = Hash.unserialize(buf);
                compressed.push(hash);
            }
            hashes.push(hash);
        }

        return new BlockInterlink(hashes, repeatBits, compressed);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._hashes.length);
        buf.write(this._repeatBits);
        for (const hash of this._compressed) {
            hash.serialize(buf);
        }
        return buf;
    }

    /**
     * @type {number}
     */
    get serializedSize() {
        return /*count*/ 1
            + this._repeatBits.length
            + this._compressed.reduce((sum, hash) => sum + hash.serializedSize, 0);
    }

    /**
     * @param {BlockInterlink|*} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof BlockInterlink
            && this._hashes.length === o._hashes.length
            && this._hashes.every((hash, i) => hash.equals(o.hashes[i]));
    }

    /**
     * @returns {Promise.<Hash>}
     */
    async hash() {
        if (!this._hash) {
            this._hash = await MerkleTree.computeRoot([this._repeatBits, ...this._compressed]);
        }
        return this._hash;
    }

    /**
     * @type {Array.<Hash>}
     */
    get hashes() {
        return this._hashes;
    }

    /**
     * @type {number}
     */
    get length() {
        return this._hashes.length;
    }
}
Class.register(BlockInterlink);

class BlockInterlinkLegacy extends BlockInterlink {
    /**
     * @param {BlockInterlink} o
     * @returns {BlockInterlinkLegacy}
     */
    static copy(o) {
        if (!o) return o;
        const hashes = o._hashes.map(it => Hash.copy(it));
        return new BlockInterlinkLegacy(hashes);
    }

    /**
     * @param {Array.<Hash>} blockHashes
     */
    constructor(blockHashes) {
        super(blockHashes);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {BlockInterlinkLegacy}
     */
    static unserialize(buf) {
        const count = buf.readUint8();
        const hashes = [];
        for (let i = 0; i < count; i++) {
            hashes.push(Hash.unserialize(buf));
        }
        return new BlockInterlinkLegacy(hashes);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     * @override
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._hashes.length);
        for (const hash of this._hashes) {
            hash.serialize(buf);
        }
        return buf;
    }

    /**
     * @type {number}
     * @override
     */
    get serializedSize() {
        let size = /*count*/ 1;
        for (const hash of this._hashes) {
            size += hash.serializedSize;
        }
        return size;
    }

    /**
     * @returns {Promise.<Hash>}
     * @override
     */
    hash() {
        return MerkleTree.computeRoot(this._hashes);
    }
}
Class.register(BlockInterlinkLegacy);

class BlockBody {
    /**
     * @param {BlockBody} o
     * @returns {BlockBody}
     */
    static copy(o) {
        if (!o) return o;
        const minerAddr = Address.copy(o._minerAddr);
        const transactions = o._transactions.map(it => Transaction.copy(it));
        return new BlockBody(minerAddr, transactions, o.extraData);
    }

    /**
     * @param {Uint8Array} extraData
     * @returns {number}
     */
    static getMetadataSize(extraData) {
        return Address.SERIALIZED_SIZE
            + /*extraDataLength*/ 1
            + extraData.byteLength
            + /*transactionsLength*/ 2;
    }

    /**
     * @param {Address} minerAddr
     * @param {Array.<Transaction>} transactions
     * @param {Uint8Array} [extraData]
     */
    constructor(minerAddr, transactions, extraData = new Uint8Array(0)) {
        if (!(minerAddr instanceof Address)) throw 'Malformed minerAddr';
        if (!Array.isArray(transactions) || transactions.some(it => !(it instanceof Transaction))) throw 'Malformed transactions';
        if (!(extraData instanceof Uint8Array) || !NumberUtils.isUint8(extraData.byteLength)) throw 'Malformed extraData';

        /** @type {Address} */
        this._minerAddr = minerAddr;
        /** @type {Array.<Transaction>} */
        this._transactions = transactions;
        /** @type {Uint8Array} */
        this._extraData = extraData;
        /** @type {Hash} */
        this._hash = null;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {BlockBody}
     */
    static unserialize(buf) {
        const minerAddr = Address.unserialize(buf);
        const extraDataLength = buf.readUint8();
        const extraData = buf.read(extraDataLength);
        const numTransactions = buf.readUint16();
        const transactions = new Array(numTransactions);
        for (let i = 0; i < numTransactions; i++) {
            transactions[i] = Transaction.unserialize(buf);
        }
        return new BlockBody(minerAddr, transactions, extraData);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._minerAddr.serialize(buf);
        buf.writeUint8(this._extraData.byteLength);
        buf.write(this._extraData);
        buf.writeUint16(this._transactions.length);
        for (const tx of this._transactions) {
            tx.serialize(buf);
        }
        return buf;
    }

    /**
     * @type {number}
     */
    get serializedSize() {
        let size = this._minerAddr.serializedSize
            + /*extraDataLength*/ 1
            + this._extraData.byteLength
            + /*transactionsLength*/ 2;
        for (const tx of this._transactions) {
            size += tx.serializedSize;
        }
        return size;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        /** @type {Transaction} */
        let previousTx = null;
        for (const tx of this._transactions) {
            // Ensure transactions are ordered.
            if (previousTx && previousTx.compareBlockOrder(tx) > 0) {
                Log.w(BlockBody, 'Invalid block - transactions not ordered.');
                return false;
            }
            previousTx = tx;

            // Check that all transactions are valid.
            if (!(await tx.verify())) { // eslint-disable-line no-await-in-loop
                Log.w(BlockBody, 'Invalid block - invalid transaction');
                return false;
            }
        }

        // Everything checks out.
        return true;
    }

    /**
     * @return {Promise.<Hash>}
     */
    async hash() {
        if (!this._hash) {
            this._hash = await MerkleTree.computeRoot([this._minerAddr, this._extraData, ...this._transactions]);
        }
        return this._hash;
    }

    /**
     * @param {BlockBody} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof BlockBody
            && this._minerAddr.equals(o.minerAddr)
            && BufferUtils.equals(this._extraData, o.extraData)
            && this._transactions.length === o.transactions.length
            && this._transactions.every((tx, i) => tx.equals(o.transactions[i]));
    }

    /** @type {Uint8Array} */
    get extraData() {
        return this._extraData;
    }

    /** @type {Address} */
    get minerAddr() {
        return this._minerAddr;
    }

    /** @type {Array.<Transaction>} */
    get transactions() {
        return this._transactions;
    }

    /** @type {number} */
    get transactionCount() {
        return this._transactions.length;
    }
}
Class.register(BlockBody);

class BlockUtils {
    /**
     * @param {number} compact
     * @returns {number}
     */
    static compactToTarget(compact) {
        return (compact & 0xffffff) * Math.pow(2, (8 * ((compact >> 24) - 3)));
    }

    /**
     * @param {number} target
     * @returns {number}
     */
    static targetToCompact(target) {
        if (!Number.isFinite(target) || Number.isNaN(target)) throw 'Invalid Target';

        // Divide to get first byte
        let size = Math.max(Math.ceil(Math.log2(target) / 8), 1);
        const firstByte = target / Math.pow(2, (size - 1) * 8);

        // If the first (most significant) byte is greater than 127 (0x7f),
        // prepend a zero byte.
        if (firstByte >= 0x80) {
            size++;
        }

        // The first byte of the 'compact' format is the number of bytes,
        // including the prepended zero if it's present.
        // The following three bytes are the first three bytes of the above
        // representation. If less than three bytes are present, then one or
        // more of the last bytes of the compact representation will be zero.
        return (size << 24) + ((target / Math.pow(2, (size - 3) * 8)) & 0xffffff);
    }

    /**
     * @param {number} target
     * @returns {number}
     */
    static getTargetHeight(target) {
        return Math.ceil(Math.log2(target));
    }

    /**
     * @param {number} target
     * @returns {number}
     */
    static getTargetDepth(target) {
        return BlockUtils.getTargetHeight(Policy.BLOCK_TARGET_MAX) - BlockUtils.getTargetHeight(target);
    }

    /**
     * @param {number} compact
     * @returns {number}
     */
    static compactToDifficulty(compact) {
        return Policy.BLOCK_TARGET_MAX / BlockUtils.compactToTarget(compact);
    }

    /**
     * @param {number} difficulty
     * @returns {number}
     */
    static difficultyToCompact(difficulty) {
        return BlockUtils.targetToCompact(BlockUtils.difficultyToTarget(difficulty));
    }

    /**
     * @param {number} difficulty
     * @returns {number}
     */
    static difficultyToTarget(difficulty) {
        return Policy.BLOCK_TARGET_MAX / difficulty;
    }

    /**
     * @param {number} target
     * @returns {number}
     */
    static targetToDifficulty(target) {
        return Policy.BLOCK_TARGET_MAX / target;
    }

    /**
     * @param {Hash} hash
     * @returns {number}
     */
    static hashToTarget(hash) {
        return parseInt(hash.toHex(), 16);
    }

    /**
     * @param {Hash} hash
     * @returns {number}
     */
    static realDifficulty(hash) {
        return BlockUtils.targetToDifficulty(BlockUtils.hashToTarget(hash));
    }

    /**
     * @param {Hash} hash
     * @param {number} target
     * @returns {boolean}
     */
    static isProofOfWork(hash, target) {
        return parseInt(hash.toHex(), 16) <= target;
    }

    /**
     * @param {number} compact
     * @returns {boolean}
     */

    static isValidCompact(compact) {
        return BlockUtils.isValidTarget(BlockUtils.compactToTarget(compact));
    }

    /**
     * @param {number} target
     * @returns {boolean}
     */
    static isValidTarget(target) {
        return target >= 1 && target <= Policy.BLOCK_TARGET_MAX;
    }

    /**
     * @param {BlockHeader} headBlock
     * @param {BlockHeader} tailBlock
     * @param {number} deltaTotalDifficulty
     * @returns {number}
     */
    static getNextTarget(headBlock, tailBlock, deltaTotalDifficulty) {
        Assert.that((headBlock.height - tailBlock.height === Policy.DIFFICULTY_BLOCK_WINDOW)
            || (headBlock.height <= Policy.DIFFICULTY_BLOCK_WINDOW && tailBlock.height === 1),
            `Tail and head block must be ${Policy.DIFFICULTY_BLOCK_WINDOW} blocks apart`);

        let actualTime = headBlock.timestamp - tailBlock.timestamp;

        // Simulate that the Policy.BLOCK_TIME was achieved for the blocks before the genesis block, i.e. we simulate
        // a sliding window that starts before the genesis block. Assume difficulty = 1 for these blocks.
        if (headBlock.height <= Policy.DIFFICULTY_BLOCK_WINDOW) {
            actualTime += (Policy.DIFFICULTY_BLOCK_WINDOW - headBlock.height + 1) * Policy.BLOCK_TIME;
            deltaTotalDifficulty += Policy.DIFFICULTY_BLOCK_WINDOW - headBlock.height + 1;
        }

        // Compute the target adjustment factor.
        const expectedTime = Policy.DIFFICULTY_BLOCK_WINDOW * Policy.BLOCK_TIME;
        let adjustment = actualTime / expectedTime;

        // Clamp the adjustment factor to [1 / MAX_ADJUSTMENT_FACTOR, MAX_ADJUSTMENT_FACTOR].
        adjustment = Math.max(adjustment, 1 / Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR);
        adjustment = Math.min(adjustment, Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR);

        // Compute the next target.
        const averageDifficulty = deltaTotalDifficulty / Policy.DIFFICULTY_BLOCK_WINDOW;
        const averageTarget = BlockUtils.difficultyToTarget(averageDifficulty);
        let nextTarget = averageTarget * adjustment;

        // Make sure the target is below or equal the maximum allowed target (difficulty 1).
        // Also enforce a minimum target of 1.
        nextTarget = Math.min(nextTarget, Policy.BLOCK_TARGET_MAX);
        nextTarget = Math.max(nextTarget, 1);

        return nextTarget;
    }
}
Class.register(BlockUtils);

class Subscription {
    /**
     * @param {Array.<Address>} addresses
     */
    static fromAddresses(addresses) {
        return new Subscription(Subscription.Type.ADDRESSES, addresses);
    }

    /**
     * @param {number} addresses
     */
    static fromMinFeePerByte(minFeePerByte) {
        return new Subscription(Subscription.Type.MIN_FEE, minFeePerByte);
    }

    /**
     * @param {Subscription.Type} type
     * @param {Array.<Address>|number} [filter]
     */
    constructor(type, filter=null) {
        if (!NumberUtils.isUint8(type)) throw new Error('Invalid type');
        if (type === Subscription.Type.ADDRESSES
            && (!Array.isArray(filter) || !NumberUtils.isUint16(filter.length)
            || filter.some(it => !(it instanceof Address)))) throw new Error('Invalid addresses');
        if (type === Subscription.Type.MIN_FEE && !NumberUtils.isUint64(filter)) throw new Error('Invalid minFeePerByte');
        this._type = type;

        this._addresses = new HashSet();
        this._minFeePerByte = 0;

        switch (type) {
            case Subscription.Type.ADDRESSES:
                this._addresses.addAll(filter);
                break;
            case Subscription.Type.MIN_FEE:
                this._minFeePerByte = filter;
                break;
        }
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Subscription}
     */
    static unserialize(buf) {
        const type = /** @type {Subscription.Type} */ buf.readUint8();
        let filter = null;
        switch (type) {
            case Subscription.Type.ADDRESSES: {
                filter = [];
                const size = buf.readUint16();
                for (let i = 0; i < size; ++i) {
                    filter.push(Address.unserialize(buf));
                }
                break;
            }
            case Subscription.Type.MIN_FEE:
                filter = buf.readUint64();
                break;
        }
        return new Subscription(type, filter);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._type);
        switch (this._type) {
            case Subscription.Type.ADDRESSES:
                buf.writeUint16(this._addresses.length);
                for (const address of this._addresses) {
                    address.serialize(buf);
                }
                break;
            case Subscription.Type.MIN_FEE:
                buf.writeUint64(this._minFeePerByte);
                break;
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let additionalSize = 0;
        switch (this._type) {
            case Subscription.Type.ADDRESSES:
                additionalSize = /*length*/ 2;
                for (const address of this._addresses) {
                    additionalSize += address.serializedSize;
                }
                break;
            case Subscription.Type.MIN_FEE:
                additionalSize = /*minFeePerByte*/ 8;
                break;
        }
        return /*type*/ 1
            + additionalSize;
    }

    /**
     * @param {Block} block
     * @returns {boolean}
     */
    matchesBlock(block) {
        switch (this._type) {
            case Subscription.Type.NONE:
                return false;
            case Subscription.Type.ANY:
            case Subscription.Type.ADDRESSES:
            case Subscription.Type.MIN_FEE:
                return true;
            default:
                throw new Error('Unknown type');
        }
    }

    /**
     * @param {Transaction} transaction
     * @returns {boolean}
     */
    matchesTransaction(transaction) {
        switch (this._type) {
            case Subscription.Type.NONE:
                return false;
            case Subscription.Type.ANY:
                return true;
            case Subscription.Type.ADDRESSES:
                return this._addresses.contains(transaction.recipient) || this._addresses.contains(transaction.sender);
            case Subscription.Type.MIN_FEE:
                return transaction.fee/transaction.serializedSize >= this._minFeePerByte;
            default:
                throw new Error('Unknown type');
        }
    }

    /**
     * @returns {string}
     */
    toString() {
        return `Subscription{type=${this._type}, addresses=[${this._addresses.values()}], minFeePerByte=${this._minFeePerByte}}`;
    }

    /** @type {Subscription.Type} */
    get type() {
        return this._type;
    }

    /** @type {Array.<Address>} */
    get addresses() {
        return this._addresses.values();
    }

    /** @type {number} */
    get minFeePerByte() {
        return this._minFeePerByte;
    }
}
/** @enum {number} */
Subscription.Type = {
    NONE: 0,
    ANY: 1,
    ADDRESSES: 2,
    MIN_FEE: 3
};
Subscription.NONE = new Subscription(Subscription.Type.NONE);
Subscription.ANY = new Subscription(Subscription.Type.ANY);
Class.register(Subscription);

/**
 * @abstract
 */
class Transaction {
    /**
     * @param {Transaction} o
     * @returns {Transaction}
     */
    static copy(o) {
        if (!o) return o;
        if (o._senderPubKey) {
            // Legacy format
            const senderPubKey = PublicKey.copy(o._senderPubKey);
            const recipientAddr = Address.copy(o._recipientAddr);
            const signature = Signature.copy(o._signature);
            return new LegacyTransaction(senderPubKey, recipientAddr, o._value, o._fee, o._nonce, signature);
        } else {
            const sender = Address.copy(o._sender);
            const recipient = Address.copy(o._recipient);
            const data = new Uint8Array(o._data);
            const proof = new Uint8Array(o._proof);
            return new Transaction(o._type, sender, o._senderType, recipient, o._recipientType, o._value, o._fee, o._nonce, data, proof);
        }
    }

    /**
     * @param {Transaction.Type} type
     * @param {Address} sender
     * @param {Account.Type} senderType
     * @param {Address} recipient
     * @param {Account.Type} recipientType
     * @param {number} value
     * @param {number} fee
     * @param {number} nonce
     * @param {Uint8Array} data
     * @param {Uint8Array} proof
     */
    constructor(type, sender, senderType, recipient, recipientType, value, fee, nonce, data, proof) {
        if (!(sender instanceof Address)) throw new Error('Malformed sender');
        if (!NumberUtils.isUint8(senderType)) throw new Error('Malformed sender type');
        if (!(recipient instanceof Address)) throw new Error('Malformed recipient');
        if (!NumberUtils.isUint8(recipientType)) throw new Error('Malformed recipient type');
        if (!NumberUtils.isUint64(value) || value === 0) throw new Error('Malformed value');
        if (!NumberUtils.isUint64(fee)) throw new Error('Malformed fee');
        if (!NumberUtils.isUint32(nonce)) throw new Error('Malformed nonce');
        if (!(data instanceof Uint8Array) || !(NumberUtils.isUint16(data.byteLength))) throw new Error('Malformed data');
        if (proof && (!(proof instanceof Uint8Array) || !(NumberUtils.isUint16(proof.byteLength)))) throw new Error('Malformed proof');

        /** @type {Transaction.Type} */
        this._type = type;
        /** @type {Address} */
        this._sender = sender;
        /** @type {Account.Type} */
        this._senderType = senderType;
        /** @type {Address} */
        this._recipient = recipient;
        /** @type {Account.Type} */
        this._recipientType = recipientType;
        /** @type {number} */
        this._value = value;
        /** @type {number} */
        this._fee = fee;
        /** @type {number} */
        this._nonce = nonce;
        /** @type {Uint8Array} */
        this._data = data;
        /** @type {Uint8Array} */
        this._proof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Transaction}
     */
    static unserialize(buf) {
        // We currently only support one transaction type: Basic.
        const type = /** @type {Transaction.Type} */ buf.readUint8();
        buf.readPos--;
        if (!Transaction.TYPE_MAP.has(type)) throw new Error('Invalid transaction type');
        return Transaction.TYPE_MAP.get(type).unserialize(buf);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serializeContent(buf) {
        buf = buf || new SerialBuffer(this.serializedContentSize);
        buf.writeUint16(this._data.byteLength);
        buf.write(this._data);
        this._sender.serialize(buf);
        buf.writeUint8(this._senderType);
        this._recipient.serialize(buf);
        buf.writeUint8(this._recipientType);
        buf.writeUint64(this._value);
        buf.writeUint64(this._fee);
        buf.writeUint32(this._nonce);
        return buf;
    }

    /** @type {number} */
    get serializedContentSize() {
        return /*dataSize*/ 2
            + this._data.byteLength
            + this._sender.serializedSize
            + /*senderType*/ 1
            + this._recipient.serializedSize
            + /*recipientType*/ 1
            + /*value*/ 8
            + /*fee*/ 8
            + /*nonce*/ 4;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        // Check that sender != recipient.
        if (this._recipient.equals(this._sender)) {
            Log.w(Transaction, 'Sender and recipient must not match', this);
            return false;
        }
        if (!Account.TYPE_MAP.has(this._senderType) || !Account.TYPE_MAP.has(this._recipientType)) {
            Log.w(Transaction, 'Invalid account type', this);
            return false;
        }
        if (!(await Account.TYPE_MAP.get(this._senderType).verifyOutgoingTransaction(this))) {
            Log.w(Transaction, 'Invalid for sender', this);
            return false;
        }
        if (!(await Account.TYPE_MAP.get(this._recipientType).verifyIncomingTransaction(this))) {
            Log.w(Transaction, 'Invalid for recipient', this);
            return false;
        }
        return true;
    }

    /** @type {number} */
    get serializedSize() {
        throw new Error('Getter needs to be overwritten by subclasses');
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        throw new Error('Method needs to be overwritten by subclasses');
    }

    /**
     * @return {Promise.<Hash>}
     */
    async hash() {
        // Exclude the signature, we don't want transactions to be malleable.
        this._hash = this._hash || await Hash.light(this.serializeContent());
        return this._hash;
    }

    /**
     * @param {Transaction} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Transaction
            && this._type === o._type
            && this._sender.equals(o._sender)
            && this._senderType === o._senderType
            && this._recipient.equals(o._recipient)
            && this._recipientType === o._recipientType
            && this._value === o._value
            && this._fee === o._fee
            && this._nonce === o._nonce
            && BufferUtils.equals(this._data, o._data)
            && BufferUtils.equals(this._proof, o._proof);
    }

    /**
     * @param {Transaction} o
     */
    compareBlockOrder(o) {
        const recCompare = this._recipient.compare(o._recipient);
        if (recCompare !== 0) return recCompare;
        if (this._nonce < o._nonce) return -1;
        if (this._nonce > o._nonce) return 1;
        if (this._fee > o._fee) return -1;
        if (this._fee < o._fee) return 1;
        if (this._value > o._value) return -1;
        if (this._value < o._value) return 1;
        return this._sender.compare(o._sender);
    }

    /**
     * @param {Transaction} o
     */
    compareAccountOrder(o) {
        const senderCompare = this._sender.compare(o._sender);
        if (senderCompare !== 0) return senderCompare;
        if (this._nonce < o._nonce) return -1;
        if (this._nonce > o._nonce) return 1;
        return Assert.that(false, 'Invalid transaction set');
    }

    /**
     * @return {string}
     */
    toString() {
        return `Transaction{`
            + `sender=${this._sender.toBase64()}, `
            + `recipient=${this._recipient.toBase64()}, `
            + `value=${this._value}, `
            + `fee=${this._fee}, `
            + `nonce=${this._nonce}`
            + `}`;
    }

    get type() {
        return this._type;
    }

    /** @type {Address} */
    get sender() {
        return this._sender;
    }

    /** @type {Account.Type} */
    get senderType() {
        return this._senderType;
    }

    /** @type {Address} */
    get recipient() {
        return this._recipient;
    }

    /** @type {Account.Type} */
    get recipientType() {
        return this._recipientType;
    }

    /** @type {number} */
    get value() {
        return this._value;
    }

    /** @type {number} */
    get fee() {
        return this._fee;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }

    /** @type {Uint8Array} */
    get data() {
        return this._data;
    }

    /** @type {Uint8Array} */
    get proof() {
        return this._proof;
    }

    // Sender proof is set by the Wallet after signing a transaction.
    /** @type {Uint8Array} */
    set proof(proof) {
        this._proof = proof;
    }
}

/**
 * Enum for Transaction types.
 * @enum
 */
Transaction.Type = {
    LEGACY: 0,
    BASIC: 1,
    EXTENDED: 2
};
/** @type {Map.<Transaction.Type, {unserialize: function(buf: SerialBuffer):Transaction}>} */
Transaction.TYPE_MAP = new Map();

Class.register(Transaction);

class SignatureProof {
    /**
     * @param {Transaction} transaction
     * @returns {Promise.<boolean>}
     */
    static verifyTransaction(transaction) {
        try {
            const buffer = new SerialBuffer(transaction.proof);
            const proof = SignatureProof.unserialize(buffer);

            // Reject proof if it is longer than needed.
            if (buffer.readPos !== buffer.byteLength) {
                Log.w(SignatureProof, 'Invalid SignatureProof - overlong');
                return Promise.resolve(false);
            }

            return proof.verify(transaction.sender, transaction.serializeContent());
        } catch (e) {
            Log.w(SignatureProof, `Failed to verify transaction: ${e.message || e}`, e);
            return Promise.resolve(false);
        }
    }

    /**
     * @param {PublicKey} publicKey
     * @param {Signature} signature
     * @returns {SignatureProof}
     */
    static singleSig(publicKey, signature) {
        return new SignatureProof(publicKey, new MerklePath([]), signature);
    }

    /**
     * @param {PublicKey} signerKey
     * @param {Array.<PublicKey>} publicKeys
     * @param {Signature} signature
     * @returns {Promise.<SignatureProof>}
     */
    static async multiSig(signerKey, publicKeys, signature) {
        const merklePath = await MerklePath.compute(publicKeys, signerKey);
        return new SignatureProof(signerKey, merklePath, signature);
    }

    /**
     * @param {PublicKey} publicKey
     * @param {MerklePath} merklePath
     * @param {Signature} signature
     */
    constructor(publicKey, merklePath, signature) {
        if (!(publicKey instanceof PublicKey)) throw new Error('Malformed publickKey');
        if (!(merklePath instanceof MerklePath)) throw new Error('Malformed merklePath');
        if (signature && !(signature instanceof Signature)) throw new Error('Malformed signature');

        /**
         * @type {PublicKey}
         * @private
         */
        this._publicKey = publicKey;
        /**
         * @type {MerklePath}
         * @private
         */
        this._merklePath = merklePath;
        /**
         * @type {Signature}
         * @private
         */
        this._signature = signature;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {SignatureProof}
     */
    static unserialize(buf) {
        const publicKey = PublicKey.unserialize(buf);
        const merklePath = MerklePath.unserialize(buf);
        const signature = Signature.unserialize(buf);
        return new SignatureProof(publicKey, merklePath, signature);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._publicKey.serialize(buf);
        this._merklePath.serialize(buf);

        // The SignatureProof is sometimes serialized before the signature is set (e.g. when creating transactions).
        // Simply don't serialize the signature if it's missing as this should never go over the wire.
        // We always expect the signature to be present when unserializing.
        if (this._signature) {
            this._signature.serialize(buf);
        }

        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return this._publicKey.serializedSize
            + this._merklePath.serializedSize
            + (this._signature ? this._signature.serializedSize : 0);
    }

    /**
     * @param {SignatureProof} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof SignatureProof
            && this._publicKey.equals(o._publicKey)
            && this._merklePath.equals(o._merklePath)
            && (this._signature ? this._signature.equals(o._signature) : this._signature === o._signature);
    }

    /**
     * @param {Address} sender
     * @param {Uint8Array} data
     * @returns {Promise.<boolean>}
     */
    async verify(sender, data) {
        const merkleRoot = await this._merklePath.computeRoot(this._publicKey);
        const signerAddr = Address.fromHash(merkleRoot);
        if (!signerAddr.equals(sender)) {
            Log.w(SignatureProof, 'Invalid SignatureProof - signer does not match sender address');
            return false;
        }

        if (!this._signature) {
            Log.w(SignatureProof, 'Invalid SignatureProof - signature is missing');
            return false;
        }

        if (!(await this._signature.verify(this._publicKey, data))) {
            Log.w(SignatureProof, 'Invalid SignatureProof - signature is invalid');
            return false;
        }

        return true;
    }

    /** @type {PublicKey} */
    get publicKey() {
        return this._publicKey;
    }

    /** @type {MerklePath} */
    get merklePath() {
        return this._merklePath;
    }

    /** @type {Signature} */
    get signature() {
        return this._signature;
    }

    /** @type {Signature} */
    set signature(signature) {
        this._signature = signature;
    }
}

Class.register(SignatureProof);

class BasicTransaction extends Transaction {
    /**
     * @param {PublicKey} senderPubKey
     * @param {Address} recipient
     * @param {number} value
     * @param {number} fee
     * @param {number} nonce
     * @param {Signature} [signature]
     */
    constructor(senderPubKey, recipient, value, fee, nonce, signature) {
        if (!(senderPubKey instanceof PublicKey)) throw new Error('Malformed senderPubKey');
        // Signature may be initially empty and can be set later.
        if (signature !== undefined && !(signature instanceof Signature)) throw new Error('Malformed signature');

        const proof = SignatureProof.singleSig(senderPubKey, signature);
        super(Transaction.Type.BASIC, senderPubKey.toAddressSync(), Account.Type.BASIC, recipient, Account.Type.BASIC, value, fee, nonce, new Uint8Array(0), proof.serialize());

        /**
         * @type {SignatureProof}
         * @private
         */
        this._signatureProof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Transaction}
     */
    static unserialize(buf) {
        const type = buf.readUint8();
        Assert.that(type === Transaction.Type.BASIC);

        const senderPubKey = PublicKey.unserialize(buf);
        const recipient = Address.unserialize(buf);
        const value = buf.readUint64();
        const fee = buf.readUint64();
        const nonce = buf.readUint32();
        const signature = Signature.unserialize(buf);
        return new BasicTransaction(senderPubKey, recipient, value, fee, nonce, signature);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._type);
        this.senderPubKey.serialize(buf);
        this._recipient.serialize(buf);
        buf.writeUint64(this._value);
        buf.writeUint64(this._fee);
        buf.writeUint32(this._nonce);
        this.signature.serialize(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*type*/ 1
            + this.senderPubKey.serializedSize
            + this._recipient.serializedSize
            + /*value*/ 8
            + /*fee*/ 8
            + /*nonce*/ 4
            + this.signature.serializedSize;
    }

    /**
     * @type {PublicKey}
     */
    get senderPubKey() {
        return this._signatureProof.publicKey;
    }

    /**
     * @type {Signature}
     */
    get signature() {
        return this._signatureProof.signature;
    }

    /**
     * @type {Signature}
     */
    set signature(signature) {
        this._signatureProof.signature = signature;
        this._proof = this._signatureProof.serialize();
    }
}
Transaction.TYPE_MAP.set(Transaction.Type.BASIC, BasicTransaction);
Class.register(BasicTransaction);

class ExtendedTransaction extends Transaction {

    /**
     * @param {Address} sender
     * @param {Account.Type} senderType
     * @param {Address} recipient
     * @param {Account.Type} recipientType
     * @param {number} value
     * @param {number} fee
     * @param {number} nonce
     * @param {Uint8Array} data
     * @param {Uint8Array} [proof]
     */
    constructor(sender, senderType, recipient, recipientType, value, fee, nonce, data, proof = new Uint8Array(0)) {
        super(Transaction.Type.EXTENDED, sender, senderType, recipient, recipientType, value, fee, nonce, data, proof);
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Transaction}
     */
    static unserialize(buf) {
        const type = /** @type {Transaction.Type} */ buf.readUint8();
        Assert.that(type === Transaction.Type.EXTENDED);

        const dataSize = buf.readUint16();
        const data = buf.read(dataSize);
        const sender = Address.unserialize(buf);
        const senderType = /** @type {Account.Type} */ buf.readUint8();
        const recipient = Address.unserialize(buf);
        const recipientType = /** @type {Account.Type} */ buf.readUint8();
        const value = buf.readUint64();
        const fee = buf.readUint64();
        const nonce = buf.readUint32();
        const proofSize = buf.readUint16();
        const proof = buf.read(proofSize);
        return new ExtendedTransaction(sender, senderType, recipient, recipientType, value, fee, nonce, data, proof);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._type);
        this.serializeContent(buf);
        buf.writeUint16(this._proof.byteLength);
        buf.write(this._proof);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*type*/ 1
            + this.serializedContentSize
            + /*proofSize*/ 2
            + this._proof.byteLength;
    }
}

Transaction.TYPE_MAP.set(Transaction.Type.EXTENDED, ExtendedTransaction);
Class.register(ExtendedTransaction);

/**
 * @deprecated
 */
class LegacyTransaction extends Transaction {

    /**
     * @param {PublicKey} senderPubKey
     * @param {Address} recipient
     * @param {number} value
     * @param {number} fee
     * @param {number} nonce
     * @param {Signature} [signature]
     */
    constructor(senderPubKey, recipient, value, fee, nonce, signature) {
        if (!(senderPubKey instanceof PublicKey)) throw new Error('Malformed senderPubKey');
        // Signature may be initially empty and can be set later.
        if (signature !== undefined && !(signature instanceof Signature)) throw new Error('Malformed signature');

        const proof = SignatureProof.singleSig(senderPubKey, signature);
        super(Transaction.Type.LEGACY, senderPubKey.toAddressSync(), Account.Type.BASIC, recipient, Account.Type.BASIC, value, fee, nonce, new Uint8Array(0), proof.serialize());

        /**
         * @type {SignatureProof}
         * @private
         */
        this._signatureProof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {Transaction}
     */
    static unserialize(buf) {
        const type = buf.readUint8();
        Assert.that(type === Transaction.Type.LEGACY);
        const version = buf.readUint16();
        Assert.that(version === 256);
        
        const senderPubKey = PublicKey.unserialize(buf);
        const recipient = Address.unserialize(buf);
        const value = buf.readUint64();
        const fee = buf.readUint64();
        const nonce = buf.readUint32();
        const signature = Signature.unserialize(buf);
        
        return new LegacyTransaction(senderPubKey, recipient, value, fee, nonce, signature);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this.serializeContent(buf);
        this.signature.serialize(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return this.serializedContentSize + Crypto.signatureSize;
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serializeContent(buf) {
        buf = buf || new SerialBuffer(this.serializedContentSize);
        buf.writeUint8(this._type);
        buf.writeUint16(256 /* version */);
        this.senderPubKey.serialize(buf);
        this._recipient.serialize(buf);
        buf.writeUint64(this._value);
        buf.writeUint64(this._fee);
        buf.writeUint32(this._nonce);
        return buf;
    }

    /** @type {number} */
    get serializedContentSize() {
        return /*type*/ 1
            + /*version*/ 2
            + this.senderPubKey.serializedSize
            + this._recipient.serializedSize
            + /*value*/ 8
            + /*fee*/ 8
            + /*nonce*/ 4;
    }

    async verify() {
        // Check that sender != recipient.
        if (this._recipient.equals(this._sender)) {
            Log.w(LegacyTransaction, 'Sender and recipient must not match');
            return false;
        }

        if (!(await this.verifySignature())) {
            Log.w(LegacyTransaction, 'Invalid signature');
            return false;
        }

        return true;
    }

    /**
     * @return {Promise.<boolean>}
     */
    verifySignature() {
        return this._signatureProof.verify(this._sender, this.serializeContent());
    }

    /**
     * @param {Transaction} o
     */
    compareBlockOrder(o) {
        const recCompare = this._recipient.compare(o._recipient);
        if (recCompare !== 0) return recCompare;
        if (this._nonce < o._nonce) return -1;
        if (this._nonce > o._nonce) return 1;
        if (this._fee > o._fee) return -1;
        if (this._fee < o._fee) return 1;
        if (this._value > o._value) return -1;
        if (this._value < o._value) return 1;
        if (o instanceof LegacyTransaction) {
            return this.senderPubKey.compare((/** @type {LegacyTransaction} */ o).senderPubKey);
        } else {
            return this._sender.compare(o._sender);
        }
    }

    /**
     * @type {PublicKey}
     */
    get senderPubKey() {
        return this._signatureProof.publicKey;
    }

    /**
     * @type {Signature}
     */
    get signature() {
        return this._signatureProof.signature;
    }

    /**
     * @type {Signature}
     */
    set signature(signature) {
        this._signatureProof.signature = signature;
        this._proof = this._signatureProof.serialize();
    }
}
Transaction.TYPE_MAP.set(Transaction.Type.LEGACY, LegacyTransaction);
Class.register(LegacyTransaction);

class TransactionsProof {
    /**
     * @param {Array.<Transaction>} transactions
     * @param {MerkleProof} proof
     */
    constructor(transactions, proof) {
        if (!transactions || !NumberUtils.isUint16(transactions.length)
            || transactions.some(it => !(it instanceof Transaction))) throw new Error('Malformed transactions');
        if (!(proof instanceof MerkleProof)) throw new Error('Malformed merkle proof');

        /** @type {Array.<Transaction>} */
        this._transactions = transactions;
        /** @type {MerkleProof} */
        this._proof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {TransactionsProof}
     */
    static unserialize(buf) {
        const count = buf.readUint16();
        const transactions = [];
        for (let i = 0; i < count; ++i) {
            transactions.push(Transaction.unserialize(buf));
        }
        const proof = MerkleProof.unserialize(buf);
        return new TransactionsProof(transactions, proof);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._transactions.length);
        for (const transaction of this._transactions) {
            transaction.serialize(buf);
        }
        this._proof.serialize(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*count*/ 2
            + this._transactions.reduce((sum, transaction) => sum + transaction.serializedSize, 0)
            + this._proof.serializedSize;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `TransactionsProof{length=${this.length}}`;
    }

    /**
     * @returns {Promise.<Hash>}
     */
    root() {
        return this._proof.computeRoot(this._transactions);
    }

    /** @type {number} */
    get length() {
        return this._transactions.length;
    }

    /** @type {Array.<Transaction>} */
    get transactions() {
        return this._transactions;
    }

    /** @type {MerkleProof} */
    get proof() {
        return this._proof;
    }
}
Class.register(TransactionsProof);

class Block {
    /**
     * @param {Block} o
     * @returns {Block}
     */
    static copy(o) {
        if (!o) return o;
        const interlink = o._header.version === BlockHeader.Version.LUNA_V1
            ? BlockInterlinkLegacy.copy(o._interlink)
            : BlockInterlink.copy(o._interlink);
        return new Block(
            BlockHeader.copy(o._header),
            interlink,
            BlockBody.copy(o._body)
        );
    }

    /**
     * @param {BlockHeader} header
     * @param {BlockInterlink} interlink
     * @param {BlockBody} [body]
     */
    constructor(header, interlink, body) {
        if (!(header instanceof BlockHeader)) throw 'Malformed header';
        if (!(interlink instanceof BlockInterlink)) throw 'Malformed interlink';
        if (body && !(body instanceof BlockBody)) throw 'Malformed body';

        /** @type {BlockHeader} */
        this._header = header;
        /** @type {BlockInterlink} */
        this._interlink = interlink;
        /** @type {BlockBody} */
        this._body = body;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {Block}
     */
    static unserialize(buf) {
        const header = BlockHeader.unserialize(buf);
        const interlink = header.version === BlockHeader.Version.LUNA_V1
            ? BlockInterlinkLegacy.unserialize(buf)
            : BlockInterlink.unserialize(buf);

        let body = undefined;
        const bodyPresent = buf.readUint8();
        if (bodyPresent) {
            body = BlockBody.unserialize(buf);
        }

        return new Block(header, interlink, body);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._header.serialize(buf);
        this._interlink.serialize(buf);

        if (this._body) {
            buf.writeUint8(1);
            this._body.serialize(buf);
        } else {
            buf.writeUint8(0);
        }

        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return this._header.serializedSize
            + this._interlink.serializedSize
            + /*bodyPresent*/ 1
            + (this._body ? this._body.serializedSize : 0);
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        // Check that the timestamp is not too far into the future.
        if (this._header.timestamp * 1000 > Time.now() + Block.TIMESTAMP_DRIFT_MAX * 1000) {
            Log.w(Block, 'Invalid block - timestamp too far in the future');
            return false;
        }

        // Check that the header hash matches the difficulty.
        if (!(await this._header.verifyProofOfWork())) {
            Log.w(Block, 'Invalid block - PoW verification failed');
            return false;
        }

        // Check that the maximum block size is not exceeded.
        if (this.serializedSize > Policy.BLOCK_SIZE_MAX) {
            Log.w(Block, 'Invalid block - max block size exceeded');
            return false;
        }

        // Verify that the interlink is valid.
        if (!(await this._verifyInterlink())) {
            return false;
        }

        // XXX Verify the body only if it is present.
        if (this.isFull() && !(await this._verifyBody())) {
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @returns {Promise.<boolean>}
     * @private
     */
    async _verifyInterlink() {
        // The genesis block has an empty interlink. Skip all interlink checks for it.
        if (this.height === 1) {
            return true;
        }

        // Check that the interlink contains at least one block.
        if (this._interlink.length === 0) {
            Log.w(Block, 'Invalid block - empty interlink');
            return false;
        }

        // Check that the interlink connects to the correct genesis block.
        if (!Block.GENESIS.HASH.equals(this._interlink.hashes[0])) {
            Log.w(Block, 'Invalid block - wrong genesis block in interlink');
            return false;
        }

        /*
        // Disabled since Block.hash() != Block.pow()
        // Check that all hashes in the interlink are hard enough for their respective depth.
        const targetHeight = BlockUtils.getTargetHeight(this.target);
        for (let depth = 1; depth < this._interlink.length; depth++) {
            if (!BlockUtils.isProofOfWork(this._interlink.hashes[depth], Math.pow(2, targetHeight - depth))) {
                Log.w(Block, 'Invalid block - invalid block in interlink');
                return false;
            }
        }
        */

        // Check that the interlinkHash given in the header matches the actual interlinkHash.
        const interlinkHash = await this._interlink.hash();
        if (!this._header.interlinkHash.equals(interlinkHash)) {
            Log.w(Block, 'Invalid block - interlink hash mismatch');
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @returns {Promise.<boolean>}
     * @private
     */
    async _verifyBody() {
        // Check that the body is valid.
        if (!(await this._body.verify())) {
            return false;
        }

        // Check that bodyHash given in the header matches the actual body hash.
        const bodyHash = await this._body.hash();
        if (!this._header.bodyHash.equals(bodyHash)) {
            Log.w(Block, 'Invalid block - body hash mismatch');
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @param {Block} predecessor
     * @returns {Promise.<boolean>}
     */
    async isImmediateSuccessorOf(predecessor) {
        // Check the header.
        if (!(await this._header.isImmediateSuccessorOf(predecessor.header))) {
            return false;
        }

        // Check that the interlink is correct.
        const interlink = await predecessor.getNextInterlink(this.target, this.version);
        if (!this._interlink.equals(interlink)) {
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @param {Block} predecessor
     * @returns {Promise.<boolean>}
     */
    async isInterlinkSuccessorOf(predecessor) {
        // Check that the height is higher than the predecessor's.
        if (this._header.height <= predecessor.header.height) {
            Log.v(Block, 'No interlink predecessor - height');
            return false;
        }

        // Check that the timestamp is greater or equal to the predecessor's timestamp.
        if (this._header.timestamp < predecessor.header.timestamp) {
            Log.v(Block, 'No interlink predecessor - timestamp');
            return false;
        }

        // Check that the predecessor is contained in this block's interlink and verify its position.
        const prevHash = await predecessor.hash();
        if (!Block.GENESIS.HASH.equals(prevHash)) {
            const prevPow = await predecessor.pow();
            const targetHeight = BlockUtils.getTargetHeight(this.target);
            let blockFound = false;
            for (let depth = 1; depth < this._interlink.length; depth++) {
                if (prevHash.equals(this._interlink.hashes[depth])) {
                    blockFound = true;
                    if (!BlockUtils.isProofOfWork(prevPow, Math.pow(2, targetHeight - depth))) {
                        Log.v(Block, 'No interlink predecessor - invalid position in interlink');
                        return false;
                    }
                }
            }
            if (!blockFound) {
                Log.v(Block, 'No interlink predecessor - not in interlink');
                return false;
            }
        }

        // If the predecessor happens to be the immediate predecessor, check additionally:
        // - that the height of the successor is one higher
        // - that the interlink is correct.
        if (this._header.prevHash.equals(prevHash)) {
            if (this._header.height !== predecessor.header.height + 1) {
                Log.v(Block, 'No interlink predecessor - immediate height');
                return false;
            }

            const interlink = await predecessor.getNextInterlink(this.target, this.version);
            const interlinkHash = await interlink.hash();
            if (!this._header.interlinkHash.equals(interlinkHash)) {
                Log.v(Block, 'No interlink predecessor - immediate interlink');
                return false;
            }
        }
        // Otherwise, if the prevHash doesn't match but the blocks should be adjacent according to their height fields,
        // this cannot be a valid successor of predecessor.
        else if (this._header.height === predecessor.height.height + 1) {
            Log.v(Block, 'No interlink predecessor - immediate height (2)');
            return false;
        }
        // Otherwise, check that the interlink construction is valid given the information we have.
        else {
            // TODO Take different targets into account.

            // The number of new blocks in the interlink is bounded by the height difference.
            /** @type {HashSet.<Hash>} */
            const hashes = new HashSet();
            hashes.addAll(this._interlink.hashes);
            hashes.removeAll(predecessor.interlink.hashes);
            if (hashes.length > this._header.height - predecessor.header.height) {
                Log.v(Block, 'No interlink predecessor - too many new blocks');
                return false;
            }

            // Check that the interlink is not too short.
            const thisDepth = BlockUtils.getTargetDepth(this.target);
            const prevDepth = BlockUtils.getTargetDepth(predecessor.target);
            const depthDiff = thisDepth - prevDepth;
            if (this._interlink.length < predecessor.interlink.length - depthDiff) {
                Log.v(Block, 'No interlink predecessor - interlink too short');
                return false;
            }

            // If the same block is found in both interlinks, all blocks at lower depths must be the same in both interlinks.
            let commonBlock = false;
            const thisInterlink = this._interlink.hashes;
            const prevInterlink = predecessor.interlink.hashes;
            for (let i = 1; i < prevInterlink.length && i - depthDiff < thisInterlink.length; i++) {
                if (prevInterlink[i].equals(thisInterlink[i - depthDiff])) {
                    commonBlock = true;
                }
                else if (commonBlock) {
                    Log.v(Block, 'No interlink predecessor - invalid common suffix');
                    return false;
                }
            }
        }

        // Check that the target adjustment between the blocks does not exceed the theoretical limit.
        const adjustmentFactor = this._header.target / predecessor.header.target;
        const heightDiff = this._header.height - predecessor.header.height;
        if (adjustmentFactor > Math.pow(Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR, heightDiff)
                || adjustmentFactor < Math.pow(Policy.DIFFICULTY_MAX_ADJUSTMENT_FACTOR, -heightDiff)) {
            Log.v(Block, 'No interlink predecessor - target adjustment out of bounds');
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @param {Block} predecessor
     * @returns {Promise.<boolean>}
     */
    async isSuccessorOf(predecessor) {
        // TODO Improve this! Lots of duplicate checks.
        return await this.isImmediateSuccessorOf(predecessor) || this.isInterlinkSuccessorOf(predecessor);
    }

    /**
     * @param {number} nextTarget
     * @param {number} [nextVersion]
     * @returns {Promise.<BlockInterlink>}
     */
    async getNextInterlink(nextTarget, nextVersion = BlockHeader.CURRENT_VERSION) {
        // Compute how much harder the block hash is than the next target.
        const pow = await this.pow();
        const nextTargetHeight = BlockUtils.getTargetHeight(nextTarget);
        let i = 1, depth = 0;
        while (BlockUtils.isProofOfWork(pow, Math.pow(2, nextTargetHeight - i))) {
            depth = i;
            i++;
        }

        // If the block hash is not hard enough and the target height didn't change, the interlink doesn't change.
        // Exception: The genesis block has an empty interlink, its successor (and all other blocks) contain the genesis hash.
        const targetHeight = BlockUtils.getTargetHeight(this.target);
        if (depth === 0 && targetHeight === nextTargetHeight) {
            const hashes = this.interlink.length > 0 ? this.interlink.hashes : [Block.GENESIS.HASH];
            return nextVersion === BlockHeader.Version.LUNA_V1
                ? new BlockInterlinkLegacy(hashes)
                : new BlockInterlink(hashes);
        }

        // The interlink changes, start constructing a new one.
        /** @type {Array.<Hash>} */
        const hashes = [Block.GENESIS.HASH];

        // Push the current block hash up to depth times onto the new interlink. If depth == 0, it won't be pushed.
        const hash = await this.hash();
        for (let i = 0; i < depth; i++) {
            hashes.push(hash);
        }

        // Push the remaining hashes from the current interlink. If the target height decreases (i.e. the difficulty
        // increases), we omit the block(s) at the beginning of the current interlink as they are not eligible for
        // inclusion anymore.
        const offset = targetHeight - nextTargetHeight;
        for (let j = depth + offset + 1; j < this.interlink.length; j++) {
            hashes.push(this.interlink.hashes[j]);
        }

        return nextVersion === BlockHeader.Version.LUNA_V1
            ? new BlockInterlinkLegacy(hashes)
            : new BlockInterlink(hashes);
    }

    /**
     * @param {Block|*} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof Block
            && this._header.equals(o._header)
            && this._interlink.equals(o._interlink)
            && (this._body ? this._body.equals(o._body) : !o._body);
    }

    /**
     * @returns {boolean}
     */
    isLight() {
        return !this._body;
    }

    /**
     * @returns {boolean}
     */
    isFull() {
        return !!this._body;
    }

    /**
     * @returns {Block}
     */
    toLight() {
        return this.isLight() ? this : new Block(this._header, this._interlink);
    }

    /**
     * @param {BlockBody} body
     * @returns {Block}
     */
    toFull(body) {
        return this.isFull() ? this : new Block(this._header, this._interlink, body);
    }

    /**
     * @type {BlockHeader}
     */
    get header() {
        return this._header;
    }

    /**
     * @type {BlockInterlink}
     */
    get interlink() {
        return this._interlink;
    }

    /**
     * @type {BlockBody}
     */
    get body() {
        if (this.isLight()) {
            throw 'Cannot access body of light block';
        }
        return this._body;
    }

    /**
     * @returns {number}
     */
    get version() {
        return this._header.version;
    }

    /**
     * @type {Hash}
     */
    get prevHash() {
        return this._header.prevHash;
    }

    /**
     * @type {Hash}
     */
    get bodyHash() {
        return this._header.bodyHash;
    }

    /**
     * @type {Hash}
     */
    get accountsHash() {
        return this._header.accountsHash;
    }

    /**
     * @type {number}
     */
    get nBits() {
        return this._header.nBits;
    }

    /**
     * @type {number}
     */
    get target() {
        return this._header.target;
    }

    /**
     * @type {number}
     */
    get difficulty() {
        return this._header.difficulty;
    }

    /**
     * @type {number}
     */
    get height() {
        return this._header.height;
    }
    
    /**
     * @type {number}
     */
    get timestamp() {
        return this._header.timestamp;
    }

    /**
     * @type {number}
     */
    get nonce() {
        return this._header.nonce;
    }

    /**
     * @type {Address}
     */
    get minerAddr() {
        return this._body.minerAddr;
    }

    /**
     * @type {Array.<Transaction>}
     */
    get transactions() {
        return this._body.transactions;
    }

    /**
     * @type {number}
     */
    get transactionCount() {
        return this._body.transactionCount;
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {Promise.<Hash>}
     */
    hash(buf) {
        return this._header.hash(buf);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {Promise.<Hash>}
     */
    pow(buf) {
        return this._header.pow(buf);
    }

}
Block.TIMESTAMP_DRIFT_MAX = 600 /* seconds */; // 10 minutes
Class.register(Block);

/* Genesis Block */
Block.GENESIS = new Block(
    new BlockHeader(
        new Hash(null),
        Hash.fromBase64('DldRwCblQ7Loqy6wYJnaodHl30d3j3eH+qtFzfEv46g='),
        Hash.fromBase64('z2Qp5kzePlvq/ABN31K1eUAQ5Dn8rpeZQU0PTQn9pH0='),
        Hash.fromBase64('kOLoEJXYHiciZb/QkswXk0GPhhg7pmHy+L1NmTbilPM='),
        BlockUtils.difficultyToCompact(1),
        1,
        0,
        66958,
        BlockHeader.Version.LUNA_V1),
    new BlockInterlinkLegacy([]),
    new BlockBody(Address.fromBase64('9KzhefhVmhN0pOSnzcIYnlVOTs0='), [])
);
// Store hash for synchronous access
Block.GENESIS.HASH = Hash.fromBase64('K3Id+E/rgqR8SB8pV0X9Fxv4FxkC5eePu/oXVaj6ZO4=');

/**
 * @interface
 */
class IBlockchain extends Observable {
    /**
     * @abstract
     * @type {Block}
     */
    get head() {}

    /**
     * @abstract
     * @type {Hash}
     */
    get headHash() {}

    /**
     * @abstract
     * @type {number}
     */
    get height() {}
}
Class.register(IBlockchain);

/**
 * @abstract
 */
class BaseChain extends IBlockchain {
    /**
     * @param {ChainDataStore} store
     */
    constructor(store) {
        super();
        this._store = store;
    }

    /**
     * @param {Hash} hash
     * @param {boolean} [includeForks]
     * @returns {Promise.<Block>}
     */
    async getBlock(hash, includeForks = false) {
        const chainData = await this._store.getChainData(hash);
        return chainData && (chainData.onMainChain || includeForks) ? chainData.head : undefined;
    }

    /**
     * @param {number} height
     * @returns {Promise.<Block>}
     */
    getBlockAt(height) {
        return this._store.getBlockAt(height);
    }

    /**
     * Computes the target value for the block after the given block or the head of this chain if no block is given.
     * @param {Block} [block]
     * @returns {Promise.<number>}
     */
    async getNextTarget(block) {
        /** @type {ChainData} */
        let headData;
        if (block) {
            const hash = await block.hash();
            headData = await this._store.getChainData(hash);
            Assert.that(!!headData);
        } else {
            block = this.head;
            headData = this._mainChain;
        }

        // Retrieve the timestamp of the block that appears DIFFICULTY_BLOCK_WINDOW blocks before the given block in the chain.
        // The block might not be on the main chain.
        const tailHeight = Math.max(block.height - Policy.DIFFICULTY_BLOCK_WINDOW, 1);
        /** @type {ChainData} */
        let tailData;
        if (headData.onMainChain) {
            tailData = await this._store.getChainDataAt(tailHeight);
        } else {
            let prevData = headData;
            for (let i = 0; i < Policy.DIFFICULTY_BLOCK_WINDOW && !prevData.onMainChain; i++) {
                prevData = await this._store.getChainData(prevData.head.prevHash);
                if (!prevData) {
                    // Not enough blocks are available to compute the next target, fail.
                    return -1;
                }
            }

            if (prevData.onMainChain && prevData.head.height > tailHeight) {
                tailData = await this._store.getChainDataAt(tailHeight);
            } else {
                tailData = prevData;
            }
        }

        if (!tailData || tailData.totalDifficulty < 1) {
            // Not enough blocks are available to compute the next target, fail.
            return -1;
        }

        const deltaTotalDifficulty = headData.totalDifficulty - tailData.totalDifficulty;
        return BlockUtils.getNextTarget(headData.head.header, tailData.head.header, deltaTotalDifficulty);
    }



    /* NIPoPoW Prover functions */

    /**
     * @returns {Promise.<ChainProof>}
     * @protected
     */
    async _getChainProof() {
        const snapshot = this._store.snapshot();
        const chain = new BaseChainSnapshot(snapshot, this.head);
        const proof = await chain._prove(Policy.M, Policy.K, Policy.DELTA);
        snapshot.abort();
        return proof;
    }

    /**
     * The "Prove" algorithm from the NIPoPow paper.
     * @param {number} m
     * @param {number} k
     * @param {number} delta
     * @returns {Promise.<ChainProof>}
     * @private
     */
    async _prove(m, k, delta) {
        Assert.that(m >= 1, 'm must be >= 1');
        Assert.that(delta > 0, 'delta must be > 0');
        let prefix = new BlockChain([]);

        // B <- C[0]
        let startHeight = 1;

        const head = await this.getBlockAt(Math.max(this.height - k, 1)); // C[-k]
        const maxDepth = Math.max(BlockUtils.getTargetDepth(head.target) + head.interlink.length - 1, 0); // |C[-k].interlink|
        // for mu = |C[-k].interlink| down to 0 do
        for (let depth = maxDepth; depth >= 0; depth--) {
            // alpha = C[:-k]{B:}|^mu
            const alpha = await this._getSuperChain(depth, head, startHeight); // eslint-disable-line no-await-in-loop

            // pi = pi (union) alpha
            prefix = BlockChain.merge(prefix, alpha);

            // if good_(delta,m)(C, alpha, mu) then
            if (BaseChain._isGoodSuperChain(alpha, depth, m, delta)) {
                Assert.that(alpha.length >= m, `Good superchain expected to be at least ${m} long`);
                Log.v(BaseChain, `Found good superchain at depth ${depth} with length ${alpha.length} (#${startHeight} - #${head.height})`);
                // B <- alpha[-m]
                startHeight = alpha.blocks[alpha.length - m].height;
            }
        }

        // X <- C[-k:]
        const suffix = await this._getHeaderChain(this.height - head.height);

        // return piX
        return new ChainProof(prefix, suffix);
    }

    /**
     * @param {number} depth
     * @param {Block} [head]
     * @param {number} [tailHeight]
     * @returns {Promise.<BlockChain>}
     * @private
     */
    async _getSuperChain(depth, head = this.head, tailHeight = 1) {
        Assert.that(tailHeight >= 1, 'tailHeight must be >= 1');
        const blocks = [];

        // Include head if it is at the requested depth or below.
        const headPow = await head.pow();
        const headDepth = BlockUtils.getTargetDepth(BlockUtils.hashToTarget(headPow));
        if (headDepth >= depth) {
            blocks.push(head.toLight());
        }

        // Follow the interlink pointers back at the requested depth.
        let references = [head.prevHash, ...head.interlink.hashes.slice(1)];
        let j = Math.max(depth - BlockUtils.getTargetDepth(head.target), 0);
        while (j < references.length && head.height > tailHeight) {
            head = await this.getBlock(references[j]); // eslint-disable-line no-await-in-loop
            if (!head) {
                // This can happen in the light/nano client if chain superquality is harmed.
                // Return a best-effort chain in this case.
                Log.w(BaseChain, `Failed to find block ${references[j]} while constructing SuperChain at depth ${depth} - returning truncated chain`);
                break;
            }
            blocks.push(head.toLight());

            references = [head.prevHash, ...head.interlink.hashes.slice(1)];
            j = Math.max(depth - BlockUtils.getTargetDepth(head.target), 0);
        }

        if ((blocks.length === 0 || blocks[blocks.length - 1].height > 1) && tailHeight === 1) {
            blocks.push(Block.GENESIS.toLight());
        }

        return new BlockChain(blocks.reverse());
    }

    /**
     * @param {BlockChain} superchain
     * @param {number} depth
     * @param {number} m
     * @param {number} delta
     * @returns {boolean}
     */
    static _isGoodSuperChain(superchain, depth, m, delta) {
        // TODO multilevel quality
        return BaseChain._hasSuperQuality(superchain, depth, m, delta);
    }

    /**
     * @param {BlockChain} superchain
     * @param {number} depth
     * @param {number} m
     * @param {number} delta
     * @returns {boolean}
     * @private
     */
    static _hasSuperQuality(superchain, depth, m, delta) {
        Assert.that(m >= 1, 'm must be >= 1');
        if (superchain.length < m) {
            return false;
        }

        for (let i = m; i <= superchain.length; i++) {
            const underlyingLength = superchain.head.height - superchain.blocks[superchain.length - i].height + 1;
            if (!BaseChain._isLocallyGood(i, underlyingLength, depth, delta)) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param {number} superLength
     * @param {number} underlyingLength
     * @param {number} depth
     * @param {number} delta
     * @returns {boolean}
     * @private
     */
    static _isLocallyGood(superLength, underlyingLength, depth, delta) {
        // |C'| > (1 - delta) * 2^(-mu) * |C|
        return superLength > (1 - delta) * Math.pow(2, -depth) * underlyingLength;
    }

    /**
     * @param {number} length
     * @param {Block} [head]
     * @returns {Promise.<HeaderChain>}
     * @private
     */
    async _getHeaderChain(length, head = this.head) {
        const headers = [];
        while (head && headers.length < length) {
            headers.push(head.header);
            head = await this.getBlock(head.prevHash); // eslint-disable-line no-await-in-loop
        }
        return new HeaderChain(headers.reverse());
    }

    /**
     * @param {ChainProof} proof
     * @param {BlockHeader} header
     * @param {boolean} [failOnBadness]
     * @returns {Promise.<ChainProof>}
     * @protected
     */
    async _extendChainProof(proof, header, failOnBadness = true) {
        // Append new header to proof suffix.
        const suffix = proof.suffix.headers.slice();
        suffix.push(header);

        // If the suffix is not long enough (short chain), we're done.
        const prefix = proof.prefix.blocks.slice();
        if (suffix.length <= Policy.K) {
            return new ChainProof(new BlockChain(prefix), new HeaderChain(suffix));
        }

        // Cut the tail off the suffix.
        const suffixTail = suffix.shift();

        // Construct light block out of the old suffix tail.
        const interlink = await proof.prefix.head.getNextInterlink(suffixTail.target, suffixTail.version);
        const prefixHead = new Block(suffixTail, interlink);

        // Append old suffix tail block to prefix.
        prefix.push(prefixHead);

        // Extract layered superchains from prefix. Make a copy because we are going to change the chains array.
        const chains = (await proof.getSuperChains()).slice();

        // Append new prefix head to chains.
        const target = BlockUtils.hashToTarget(await prefixHead.pow());
        const depth = BlockUtils.getTargetDepth(target);
        for (let i = depth; i >= 0; i--) {
            // Append block. Don't modify the chain, create a copy.
            if (!chains[i]) {
                chains[i] = new BlockChain([prefixHead]);
            } else {
                chains[i] = new BlockChain([...chains[i].blocks, prefixHead]);
            }
        }

        // If the new header isn't a superblock, we're done.
        if (depth - BlockUtils.getTargetDepth(prefixHead.target) <= 0) {
            return new ChainProof(new BlockChain(prefix), new HeaderChain(suffix), chains);
        }

        // Prune unnecessary blocks if the chain is good.
        // Try to extend proof if the chain is bad.
        const deletedBlockHeights = new Set();
        for (let i = depth; i >= 0; i--) {
            const superchain = chains[i];
            if (superchain.length < Policy.M) {
                continue;
            }

            if (BaseChain._isGoodSuperChain(superchain, i, Policy.M, Policy.DELTA)) {
                // Remove all blocks in lower chains up to (including) superchain[-m].
                const referenceBlock = superchain.blocks[superchain.length - Policy.M];
                for (let j = i - 1; j >= 0; j--) {
                    let numBlocksToDelete = 0;
                    let candidateBlock = chains[j].blocks[numBlocksToDelete];
                    while (candidateBlock.height <= referenceBlock.height) {
                        const candidateTarget = BlockUtils.hashToTarget(await candidateBlock.pow());
                        const candidateDepth = BlockUtils.getTargetDepth(candidateTarget);
                        if (candidateDepth === j && candidateBlock.height > 1) {
                            deletedBlockHeights.add(candidateBlock.height);
                        }

                        numBlocksToDelete++;
                        candidateBlock = chains[j].blocks[numBlocksToDelete];
                    }

                    if (numBlocksToDelete > 0) {
                        // Don't modify the chain, create a copy.
                        chains[j] = new BlockChain(chains[j].blocks.slice(numBlocksToDelete));
                    }
                }
            } else {
                Log.w(BaseChain, `Chain quality badness detected at depth ${i}`);
                // TODO extend superchains at lower levels
                if (failOnBadness) {
                    return null;
                }
            }
        }

        // Remove all deleted blocks from prefix.
        const newPrefix = new BlockChain(prefix.filter(block => !deletedBlockHeights.has(block.height)));

        // Return the extended proof.
        return new ChainProof(newPrefix, new HeaderChain(suffix), chains);
    }


    /* NiPoPoW Verifier functions */

    /**
     * @param {ChainProof} proof1
     * @param {ChainProof} proof2
     * @param {number} m
     * @returns {boolean}
     */
    static async isBetterProof(proof1, proof2, m) {
        const lca = BlockChain.lowestCommonAncestor(proof1.prefix, proof2.prefix);
        const score1 = await NanoChain._getProofScore(proof1.prefix, lca, m);
        const score2 = await NanoChain._getProofScore(proof2.prefix, lca, m);
        return score1 === score2
            ? proof1.suffix.totalDifficulty() >= proof2.suffix.totalDifficulty()
            : score1 > score2;
    }

    /**
     *
     * @param {BlockChain} chain
     * @param {Block} lca
     * @param {number} m
     * @returns {Promise.<number>}
     * @protected
     */
    static async _getProofScore(chain, lca, m) {
        const counts = [];
        for (const block of chain.blocks) {
            if (block.height < lca.height) {
                continue;
            }

            const target = BlockUtils.hashToTarget(await block.pow()); // eslint-disable-line no-await-in-loop
            const depth = BlockUtils.getTargetDepth(target);
            counts[depth] = counts[depth] ? counts[depth] + 1 : 1;
        }

        let sum = 0;
        let depth;
        for (depth = counts.length - 1; sum < m && depth >= 0; depth--) {
            sum += counts[depth] ? counts[depth] : 0;
        }

        let maxScore = Math.pow(2, depth + 1) * sum;
        let length = sum;
        for (let i = depth; i >= 0; i--) {
            length += counts[i] ? counts[i] : 0;
            const score = Math.pow(2, i) * length;
            maxScore = Math.max(maxScore, score);
        }

        return maxScore;
    }
}
Class.register(BaseChain);

class BaseChainSnapshot extends BaseChain {
    /**
     * @param {ChainDataStore} store
     * @param {Block} head
     */
    constructor(store, head) {
        super(store);
        this._head = head;
    }

    /** @type {Block} */
    get head() {
        return this._head;
    }

    /** @type {number} */
    get height() {
        return this._head.height;
    }
}
Class.register(BaseChainSnapshot);

class BlockChain {
    /**
     * @param {BlockChain} chain1
     * @param {BlockChain} chain2
     * @returns {BlockChain}
     */
    static merge(chain1, chain2) {
        const merged = [];
        let i1 = 0, i2 = 0;
        while (i1 < chain1.length && i2 < chain2.length) {
            const block1 = chain1.blocks[i1];
            const block2 = chain2.blocks[i2];

            if (block1.height === block2.height) {
                Assert.that(block1.equals(block2), 'Encountered different blocks at same height during chain merge');
                merged.push(block1);
                i1++;
                i2++;
            } else if (block1.height < block2.height) {
                merged.push(block1);
                i1++;
            } else {
                merged.push(block2);
                i2++;
            }
        }

        for (; i1 < chain1.length; i1++) {
            merged.push(chain1.blocks[i1]);
        }
        for (; i2 < chain2.length; i2++) {
            merged.push(chain2.blocks[i2]);
        }

        return new BlockChain(merged);
    }

    /**
     * @param {BlockChain} chain1
     * @param {BlockChain} chain2
     * @returns {?Block}
     */
    static lowestCommonAncestor(chain1, chain2) {
        let i1 = chain1.length - 1;
        let i2 = chain2.length - 1;
        while (i1 >= 0 && i2 >= 0) {
            const block1 = chain1.blocks[i1];
            const block2 = chain2.blocks[i2];

            if (block1.equals(block2)) {
                return block1;
            } else if (block1.height > block2.height) {
                i1--;
            } else {
                i2--;
            }
        }
        return undefined;
    }

    /**
     * @param {Array.<Block>} blocks
     */
    constructor(blocks) {
        if (!blocks || !NumberUtils.isUint16(blocks.length)
            || blocks.some(it => !(it instanceof Block) || !it.isLight())) throw new Error('Malformed blocks');

        /** @type {Array.<Block>} */
        this._blocks = blocks;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {BlockChain}
     */
    static unserialize(buf) {
        const count = buf.readUint16();
        const blocks = [];
        for (let i = 0; i < count; i++) {
            const header = BlockHeader.unserialize(buf);
            let interlink = BlockInterlink.unserialize(buf);
            // FIXME: Remove for mainnet.
            if (header.version === BlockHeader.Version.LUNA_V1) {
                interlink = new BlockInterlinkLegacy(interlink.hashes);
            }
            blocks.push(new Block(header, interlink));
        }
        return new BlockChain(blocks);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._blocks.length);
        for (const block of this._blocks) {
            block.header.serialize(buf);
            // FIXME: Remove for mainnet.
            if (block.version === BlockHeader.Version.LUNA_V1) {
                (new BlockInterlink(block.interlink.hashes)).serialize(buf);
            } else {
                block.interlink.serialize(buf);
            }
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*count*/ 2
            + this._blocks.reduce((sum, block) => {
                let size = block.serializedSize;
                if (block.version === BlockHeader.Version.LUNA_V1) {
                    size += (new BlockInterlink(block.interlink.hashes)).serializedSize - block.interlink.serializedSize;
                }
                return sum + size;
            }, 0);
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        // For performance reasons, we DO NOT VERIFY the validity of the blocks in the chain here.
        // Block validity is checked by the Nano/LightChain upon receipt of a ChainProof.

        // Check that all blocks in the chain are valid successors of one another.
        for (let i = this._blocks.length - 1; i >= 1; i--) {
            if (!(await this._blocks[i].isSuccessorOf(this._blocks[i - 1]))) { // eslint-disable-line no-await-in-loop
                return false;
            }
        }

        // Everything checks out.
        return true;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async isDense() {
        for (let i = this._blocks.length - 1; i >= 1; i--) {
            const prevHash = await this._blocks[i - 1].hash(); // eslint-disable-line no-await-in-loop
            if (!prevHash.equals(this._blocks[i].prevHash)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @returns {Promise.<Array.<Block>>}
     */
    async denseSuffix() {
        // Compute the dense suffix.
        const denseSuffix = [this.head];
        let denseSuffixHead = this.head;
        for (let i = this.length - 2; i >= 0; i--) {
            const block = this.blocks[i];
            const hash = await block.hash();
            if (!hash.equals(denseSuffixHead.prevHash)) {
                break;
            }

            denseSuffix.push(block);
            denseSuffixHead = block;
        }
        denseSuffix.reverse();
        return denseSuffix;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async isAnchored() {
        return Block.GENESIS.HASH.equals(await this.tail.hash());
    }

    /**
     * @returns {string}
     */
    toString() {
        return `BlockChain{length=${this.length}}`;
    }

    /** @type {number} */
    get length() {
        return this._blocks.length;
    }

    /** @type {Array.<Block>} */
    get blocks() {
        return this._blocks;
    }

    /** @type {Block} */
    get head() {
        return this._blocks[this.length - 1];
    }

    /** @type {Block} */
    get tail() {
        return this._blocks[0];
    }

    /**
     * @returns {number}
     */
    totalDifficulty() {
        return this._blocks.reduce((sum, block) => sum + BlockUtils.targetToDifficulty(block.target), 0);
    }
}
Class.register(BlockChain);

class HeaderChain {
    /**
     * @param {Array.<BlockHeader>} headers
     */
    constructor(headers) {
        if (!headers || !Array.isArray(headers) || !NumberUtils.isUint16(headers.length)
            || headers.some(it => !(it instanceof BlockHeader))) throw new Error('Malformed headers');

        /** @type {Array.<BlockHeader>} */
        this._headers = headers;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {HeaderChain}
     */
    static unserialize(buf) {
        const count = buf.readUint16();
        const headers = [];
        for (let i = 0; i < count; i++) {
            headers.push(BlockHeader.unserialize(buf));
        }
        return new HeaderChain(headers);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint16(this._headers.length);
        for (const header of this._headers) {
            header.serialize(buf);
        }
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*count*/ 2
            + this._headers.reduce((sum, header) => sum + header.serializedSize, 0);
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        // For performance reasons, we DO NOT VERIFY the validity of the blocks in the chain here.
        // Block validity is checked by the Nano/LightChain upon receipt of a ChainProof.

        // Check that all headers in the chain are valid successors of one another.
        for (let i = this._headers.length - 1; i >= 1; i--) {
            if (!(await this._headers[i].isImmediateSuccessorOf(this._headers[i - 1]))) { // eslint-disable-line no-await-in-loop
                return false;
            }
        }

        // Everything checks out.
        return true;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `HeaderChain{length=${this.length}}`;
    }

    /** @type {number} */
    get length() {
        return this._headers.length;
    }

    /** @type {Array.<BlockHeader>} */
    get headers() {
        return this._headers;
    }

    /** @type {BlockHeader} */
    get head() {
        return this._headers[this.length - 1];
    }

    /** @type {BlockHeader} */
    get tail() {
        return this._headers[0];
    }

    /**
     * @returns {number}
     */
    totalDifficulty() {
        return this._headers.reduce((sum, header) => sum + BlockUtils.targetToDifficulty(header.target), 0);
    }
}
Class.register(HeaderChain);

class ChainProof {
    /**
     * @param {BlockChain} prefix
     * @param {HeaderChain} suffix
     * @param {Array.<BlockChain>} [superChains]
     */
    constructor(prefix, suffix, superChains) {
        if (!(prefix instanceof BlockChain) || !prefix.length) throw new Error('Malformed prefix');
        if (!(suffix instanceof HeaderChain)) throw new Error('Malformed suffix');

        /** @type {BlockChain} */
        this._prefix = prefix;
        /** @type {HeaderChain} */
        this._suffix = suffix;
        /** @type {?Array.<BlockChain>} */
        this._chains = superChains;
    }

    static unserialize(buf) {
        const prefix = BlockChain.unserialize(buf);
        const suffix = HeaderChain.unserialize(buf);
        return new ChainProof(prefix, suffix);
    }

    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        this._prefix.serialize(buf);
        this._suffix.serialize(buf);
        return buf;
    }

    get serializedSize() {
        return this._prefix.serializedSize
            + this._suffix.serializedSize;
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async verify() {
        // Check that the prefix chain is anchored.
        if (!this._prefix.isAnchored()) {
            return false;
        }

        // Check that both prefix and suffix are valid chains.
        if (!(await this._prefix.verify()) || !(await this._suffix.verify())) {
            return false;
        }

        // Check that the suffix connects to the prefix.
        if (this._suffix.length > 0 && !(await this._suffix.tail.isImmediateSuccessorOf(this._prefix.head.header))) {
            return false;
        }

        // Verify the block targets where possible.
        if (!(await this._verifyDifficulty())) {
            return false;
        }

        // Everything checks out.
        return true;
    }

    /**
     * @returns {Promise.<boolean>}
     * @private
     */
    async _verifyDifficulty() {
        // Extract the dense suffix of the prefix.
        /** Array.<BlockHeader> */
        const denseSuffix = (await this.prefix.denseSuffix()).map(block => block.header);
        /** Array.<BlockHeader> */
        const denseChain = denseSuffix.concat(this.suffix.headers);

        // Compute totalDifficulty for each block of the dense chain.
        let totalDifficulty = 0;
        const totalDifficulties = [];
        for (let i = 0; i < denseChain.length; i++) {
            totalDifficulty += denseChain[i].difficulty;
            totalDifficulties[i] = totalDifficulty;
        }

        let headIndex = denseChain.length - 2;
        let tailIndex = headIndex - Policy.DIFFICULTY_BLOCK_WINDOW;
        while (tailIndex >= 0 && headIndex >= 0) {
            const headBlock = denseChain[headIndex];
            const tailBlock = denseChain[tailIndex];
            const deltaTotalDifficulty = totalDifficulties[headIndex] - totalDifficulties[tailIndex];
            const target = BlockUtils.getNextTarget(headBlock, tailBlock, deltaTotalDifficulty);
            const nBits = BlockUtils.targetToCompact(target);

            /** @type {BlockHeader} */
            const checkBlock = denseChain[headIndex + 1];
            if (checkBlock.nBits !== nBits) {
                Log.w(ChainProof, `Block target mismatch: expected=${nBits}, got=${checkBlock.nBits}`);
                return false;
            }

            --headIndex;
            if (tailIndex !== 0 || tailBlock.height !== 1) {
                --tailIndex;
            }
        }

        return true;
    }

    /**
     * @returns {Promise.<Array.<BlockChain>>}
     */
    async getSuperChains() {
        if (!this._chains) {
            this._chains = [];
            for (let i = 0; i < this._prefix.length; i++) {
                const block = this._prefix.blocks[i];
                const target = BlockUtils.hashToTarget(await block.pow());
                const depth = BlockUtils.getTargetDepth(target);

                if (this._chains[depth]) {
                    this._chains[depth].blocks.push(block);
                } else if (!this._chains[depth]) {
                    this._chains[depth] = new BlockChain([block]);
                }

                for (let j = depth - 1; j >= 0; j--) {
                    if (this._chains[j]) {
                        this._chains[j].blocks.push(block);
                    } else {
                        this._chains[j] = new BlockChain([]);
                    }
                }
            }
        }
        return this._chains;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `ChainProof{prefix=${this._prefix.length}, suffix=${this._suffix.length}, height=${this.head.height}}`;
    }

    /** @type {BlockChain} */
    get prefix() {
        return this._prefix;
    }

    /** @type {HeaderChain} */
    get suffix() {
        return this._suffix;
    }

    /** @type {BlockHeader} */
    get head() {
        return this._suffix.length > 0 ? this._suffix.head : this._prefix.head.header;
    }
}
Class.register(ChainProof);

class ChainData {
    /**
     * @param {ChainData} o
     * @returns {ChainData}
     */
    static copy(o) {
        if (!o) return o;
        const head = Block.unserialize(new SerialBuffer(o._head));
        head.header._pow = Hash.unserialize(new SerialBuffer(o._pow));
        return new ChainData(
            head,
            o._totalDifficulty,
            o._totalWork,
            o._onMainChain
        );
    }

    /**
     * @param {Block} head
     * @param {number} totalDifficulty
     * @param {number} totalWork
     * @param {boolean} onMainChain
     */
    constructor(head, totalDifficulty, totalWork, onMainChain = false) {
        this._head = head;
        this._totalDifficulty = totalDifficulty;
        this._totalWork = totalWork;
        this._onMainChain = onMainChain;
        this._height = head.height;
    }

    stripDown() {
        Assert.that(this._head.header._pow instanceof Hash, 'Expected cashed PoW hash');
        return {
            _head: this._head.serialize(),
            _totalDifficulty: this._totalDifficulty,
            _totalWork: this._totalWork,
            _onMainChain: this._onMainChain,
            _height: this._height,
            _pow: this._head.header._pow.serialize()
        };
    }

    /** @type {Block} */
    get head() {
        return this._head;
    }

    /** @type {number} */
    get totalDifficulty() {
        return this._totalDifficulty;
    }

    /** @type {number} */
    get totalWork() {
        return this._totalWork;
    }

    /** @type {boolean} */
    get onMainChain() {
        return this._onMainChain;
    }

    /** @type {boolean} */
    set onMainChain(onMainChain) {
        this._onMainChain = onMainChain;
    }
}
Class.register(ChainData);

class ChainDataStore {
    /**
     * @param {JungleDB} jdb
     */
    static initPersistent(jdb) {
        const store = jdb.createObjectStore('ChainData', new ChainDataStoreCodec());
        ChainDataStore._createIndexes(store);
    }

    /**
     * @param {JungleDB} jdb
     * @returns {ChainDataStore}
     */
    static getPersistent(jdb) {
        return new ChainDataStore(jdb.getObjectStore('ChainData'));
    }

    /**
     * @returns {ChainDataStore}
     */
    static createVolatile() {
        const store = JDB.JungleDB.createVolatileObjectStore();
        ChainDataStore._createIndexes(store);
        return new ChainDataStore(store);
    }

    /**
     * @param {IObjectStore} store
     * @private
     */
    static _createIndexes(store) {
        store.createIndex('height', ['_height']);
    }

    /**
     * @param {IObjectStore} store
     */
    constructor(store) {
        /** @type {IObjectStore} */
        this._store = store;
    }

    /**
     * @param {Hash} key
     * @returns {Promise.<ChainData>}
     */
    getChainData(key) {
        return this._store.get(key.toBase64());
    }

    /**
     * @param {Hash} key
     * @param {ChainData} chainData
     * @returns {Promise.<void>}
     */
    putChainData(key, chainData) {
        return this._store.put(key.toBase64(), chainData);
    }

    /**
     * @param {Hash} key
     * @returns {Block}
     */
    async getBlock(key) {
        const chainData = await this.getChainData(key);
        return chainData ? chainData.head : undefined;
    }

    /**
     * @param {number} height
     * @returns {Promise.<?ChainData>}
     */
    async getChainDataAt(height) {
        /** @type {Array.<ChainData>} */
        const candidates = await this._store.values(JDB.Query.eq('height', height));
        if (!candidates || !candidates.length) {
            return undefined;
        }

        for (const chainData of candidates) {
            if (chainData.onMainChain) {
                return chainData;
            }
        }

        return undefined;
    }

    /**
     * @param {number} height
     * @returns {Promise.<?Block>}
     */
    async getBlockAt(height) {
        const chainData = await this.getChainDataAt(height);
        return chainData ? chainData.head : undefined;
    }

    /**
     * @param {number} height
     * @param {boolean} [lower]
     * @returns {Promise.<?Block>}
     */
    async getNearestBlockAt(height, lower=true) {
        const index = this._store.index('height');
        /** @type {Array.<ChainData>} */
        const candidates = lower ?
            await index.maxValues(JDB.KeyRange.upperBound(height)) :
            await index.minValues(JDB.KeyRange.lowerBound(height));
        if (!candidates || !candidates.length) {
            return undefined;
        }

        for (const chainData of candidates) {
            if (chainData.onMainChain) {
                return chainData.head;
            }
        }

        // TODO handle corrupted storage
        throw new Error(`Failed to find main chain block at height ${height}`);
    }

    /**
     * @param {number} startHeight
     * @param {number} [count]
     * @param {boolean} [forward]
     * @returns {Promise.<Array.<Block>>}
     */
    async getBlocks(startHeight, count = 500, forward = true) {
        if (!forward) {
            startHeight = startHeight - count;
        }
        /** @type {Array.<ChainData>} */
        let candidates = await this._store.values(JDB.Query.within('height', startHeight, startHeight + count - 1));
        candidates = candidates
            .filter(chainData => chainData.onMainChain)
            .map(chainData => chainData.head);
        const sortNumber = forward ? ((a, b) => a.height - b.height) : ((a, b) => b.height - a.height);
        candidates.sort(sortNumber);
        return candidates;
    }

    /**
     * @returns {Promise.<Hash|undefined>}
     */
    async getHead() {
        const key = await this._store.get('main');
        return key ? Hash.fromBase64(key) : undefined;
    }

    /**
     * @param {Hash} key
     * @returns {Promise.<void>}
     */
    setHead(key) {
        return this._store.put('main', key.toBase64());
    }

    /**
     * @param {boolean} [enableWatchdog]
     * @returns {ChainDataStore}
     */
    transaction(enableWatchdog = true) {
        const tx = this._store.transaction(enableWatchdog);
        return new ChainDataStore(tx);
    }

    /**
     * @returns {Promise}
     */
    commit() {
        return this._store.commit();
    }

    /**
     * @returns {Promise}
     */
    abort() {
        return this._store.abort();
    }

    /**
     * @returns {ChainDataStore}
     */
    snapshot() {
        const snapshot = this._store.snapshot();
        return new ChainDataStore(snapshot);
    }

    /**
     * @returns {Promise}
     */
    truncate() {
        return this._store.truncate();
    }

    /** @type {Transaction} */
    get tx() {
        if (this._store instanceof JDB.Transaction) {
            return this._store;
        }
        return undefined;
    }
}
Class.register(ChainDataStore);

/**
 * @implements {ICodec}
 */
class ChainDataStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return typeof obj === 'string' ? obj : obj.stripDown();
    }

    /**
     * @param {*} obj The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(obj, key) {
        return typeof obj === 'string' ? obj : ChainData.copy(obj);
    }

    /**
     * @type {{encode: function(val:*):*, decode: function(val:*):*, buffer: boolean, type: string}|void}
     */
    get valueEncoding() {
        return JDB.JungleDB.JSON_ENCODING;
    }
}

class MempoolTransactionSet {
    constructor() {
        /** @type {Array.<Transaction>} */
        this._transactions = [];
    }

    /**
     * @param {Transaction} transaction
     * @return {MempoolTransactionSet}
     */
    add(transaction) {
        this._transactions.push(transaction);
        return this;
    }

    /** @type {Array.<Transaction>} */
    get transactions() {
        return this._transactions;
    }

    /** @type {number} */
    get serializedSize() {
        return this._transactions.map(t => t.serializedSize).reduce((a, b) => a + b, 0);
    }

    /** @type {number} */
    get value() {
        return this._transactions.map(t => t.value).reduce((a, b) => a + b, 0);
    }

    /** @type {number} */
    get fee() {
        return this._transactions.map(t => t.fee).reduce((a, b) => a + b, 0);
    }

    /** @type {Address} */
    get sender() {
        return this._transactions.length > 0 ? this._transactions[0].sender : null;
    }

    /** @type {?Account.Type} */
    get senderType() {
        return this._transactions.length > 0 ? this._transactions[0].senderType : undefined;
    }

    /** @type {number} */
    get length() {
        return this._transactions.length;
    }

    /** @type {number} */
    get nonce() {
        return this._transactions[0].nonce;
    }

    /**
     * @param {number} feePerByte
     * @return {number}
     */
    numBelowFeePerByte(feePerByte) {
        return this._transactions.filter(t => t.fee/t.serializedSize < feePerByte).length;
    }

    /**
     * @return {Transaction}
     */
    shift() {
        return this._transactions.shift();
    }

    /**
     * @param {MempoolTransactionSet} o
     * @return {number}
     */
    compare(o) {
        if (this.fee/this.serializedSize > o.fee/o.serializedSize) return -1;
        if (this.fee/this.serializedSize < o.fee/o.serializedSize) return 1;
        if (this.serializedSize > o.serializedSize) return -1;
        if (this.serializedSize < o.serializedSize) return 1;
        if (this.fee > o.fee) return -1;
        if (this.fee < o.fee) return 1;
        if (this.value > o.value) return -1;
        if (this.value < o.value) return 1;
        return this.transactions[0].compareBlockOrder(o.transactions[0]);
    }

    toString() {
        return `MempoolTransactionSet{senderKey=${this.senderPubKey}, length=${this.length}, value=${this.value}, fee=${this.fee}}`;
    }
}

Class.register(MempoolTransactionSet);

class Mempool extends Observable {
    /**
     * @param {IBlockchain} blockchain
     * @param {Accounts} accounts
     */
    constructor(blockchain, accounts) {
        super();
        /** @type {IBlockchain} */
        this._blockchain = blockchain;
        /** @type {Accounts} */
        this._accounts = accounts;

        // Our pool of transactions.
        /** @type {HashMap.<Hash, MempoolTransactionSet>} */
        this._transactionsByHash = new HashMap();
        /** @type {HashMap.<Address, MempoolTransactionSet>} */
        this._transactionSetByAddress = new HashMap();
        /** @type {HashMap.<Address, Array.<Transaction>>} */
        this._waitingTransactions = new HashMap();
        /** @type {HashMap.<Address, *>} */
        this._waitingTransactionTimeout = new HashMap();
        /** @type {Synchronizer} */
        this._synchronizer = new Synchronizer();

        // Listen for changes in the blockchain head to evict transactions that
        // have become invalid.
        blockchain.on('head-changed', () => this._evictTransactions());
    }

    /**
     * @param {Transaction} transaction
     * @fires Mempool#transaction-added
     * @returns {Promise.<Mempool.ReturnCode>}
     */
    pushTransaction(transaction) {
        return this._synchronizer.push(() => this._pushTransaction(transaction));
    }

    /**
     * @param {Transaction} transaction
     * @returns {Promise.<Mempool.ReturnCode>}
     * @private
     */
    async _pushTransaction(transaction) {
        // Check if we already know this transaction.
        const hash = await transaction.hash();
        if (this._transactionsByHash.contains(hash)) {
            Log.v(Mempool, () => `Ignoring known transaction ${hash.toBase64()}`);
            return Mempool.ReturnCode.KNOWN;
        }

        // Intrinsic transaction verification
        if (!(await transaction.verify())) {
            return Mempool.ReturnCode.INVALID;
        }

        // Retrieve sender account.
        /** @type {Account} */
        let senderAccount;
        try {
            senderAccount = await this._accounts.get(transaction.sender, transaction.senderType);
        } catch (e) {
            Log.w(Mempool, `Rejected transaction - ${e.message}`, transaction);
            return Mempool.ReturnCode.INVALID;
        }

        // Fully verify the transaction against the current accounts state + Mempool.
        const set = this._transactionSetByAddress.get(transaction.sender) || new MempoolTransactionSet();
        if (!(await senderAccount.verifyOutgoingTransactionSet([...set.transactions, transaction], this._blockchain.height + 1))) {
            if (transaction.nonce > senderAccount.nonce + set.length) {
                this._waitTransaction(hash, transaction);
            }

            return Mempool.ReturnCode.INVALID;
        }

        // Check limit for free transactions.
        if (transaction.fee/transaction.serializedSize < Mempool.TRANSACTION_RELAY_FEE_MIN
            && set.numBelowFeePerByte(Mempool.TRANSACTION_RELAY_FEE_MIN) >= Mempool.FREE_TRANSACTIONS_PER_SENDER_MAX) {
            return Mempool.ReturnCode.FEE_TOO_LOW;
        }

        // Transaction is valid, add it to the mempool.
        set.add(transaction);
        this._transactionsByHash.put(hash, transaction);
        this._transactionSetByAddress.put(transaction.sender, set);

        // Tell listeners about the new valid transaction we received.
        this.fire('transaction-added', transaction);

        if (this._waitingTransactions.contains(transaction.sender)) {
            /** @type {Array.<Transaction>} */
            const txs = this._waitingTransactions.get(transaction.sender);
            /** @type {Transaction} */
            let tx;
            while ((tx = txs.shift())) {
                if ((await senderAccount.verifyOutgoingTransactionSet([...set.transactions, tx], this._blockchain.height + 1, true))) {
                    set.add(tx);
                    this.fire('transaction-added', tx);
                } else {
                    break;
                }
            }
            if (tx) {
                txs.unshift(tx);
            } else {
                clearTimeout(this._waitingTransactionTimeout.get(transaction.sender));
                this._waitingTransactions.remove(transaction.sender);
                this._waitingTransactionTimeout.remove(transaction.sender);
            }
        }

        return Mempool.ReturnCode.ACCEPTED;
    }

    /**
     * @param {Hash} hash
     * @param {Transaction} transaction
     * @private
     */
    _waitTransaction(hash, transaction) {
        const txs = this._waitingTransactions.get(transaction.sender) || [];
        if (txs.length >= Mempool.WAITING_TRANSACTIONS_PER_SENDER_MAX) {
            Log.d(Mempool, `Discarding transaction ${hash} from ${transaction.sender} - max waiting transactions per sender reached`);
            return;
        }
        if (this._waitingTransactions.length >= Mempool.WAITING_TRANSACTION_SENDERS_MAX) {
            Log.d(Mempool, `Discarding transaction ${hash} from ${transaction.sender} - max waiting transaction senders reached`);
            return;
        }

        if (this._waitingTransactionTimeout.contains(transaction.sender)) {
            clearTimeout(this._waitingTransactionTimeout.get(transaction.sender));
        }

        Log.d(Mempool, `Delaying transaction ${hash} - nonce ${transaction.nonce} suggests future validity`);

        txs.push(transaction);
        try {
            txs.sort((a, b) => a.compareAccountOrder(b));
        } catch (e) {
            // Unsortable transactions => abandon all.
            Log.w(Mempool, `Abandoning ${txs.length} waiting transactions from ${transaction.sender} - duplicate nonce`);
            this._waitingTransactionTimeout.remove(transaction.sender);
            this._waitingTransactions.remove(transaction.sender);
            return;
        }

        this._transactionsByHash.put(hash, transaction);
        this._waitingTransactions.put(transaction.sender, txs);

        this._waitingTransactionTimeout.put(transaction.sender, setTimeout(async () => {
            for (const tx of txs) {
                this._transactionsByHash.remove(await tx.hash());
            }
            this._waitingTransactionTimeout.remove(transaction.sender);
            this._waitingTransactions.remove(transaction.sender);
        }, Mempool.WAITING_TRANSACTION_TIMEOUT));
    }

    /**
     * @param {Hash} hash
     * @returns {Transaction}
     */
    getTransaction(hash) {
        return this._transactionsByHash.get(hash);
    }

    /**
     * @param {number} [maxSize]
     * @returns {Array.<Transaction>}
     */
    getTransactions(maxSize=Infinity) {
        const transactions = [];
        let size = 0;
        /** @type {MempoolTransactionSet} */
        let largeSet = null;
        for (const set of this._transactionSetByAddress.values().sort((a, b) => a.compare(b))) {
            const setSize = set.serializedSize;
            if (size >= maxSize) break;
            if (size + setSize > maxSize) {
                largeSet = largeSet || set;
                continue;
            }

            transactions.push(...set.transactions);
            size += setSize;
        }

        if (size < maxSize && largeSet) {
            for (const transaction of largeSet.transactions) {
                const txSize = transaction.serializedSize;
                if (size >= maxSize) break;
                if (size + txSize > maxSize) continue;

                transactions.push(transaction);
                size += txSize;
            }
        }

        return transactions;
    }

    /**
     * @param {number} maxSize
     */
    getTransactionsForBlock(maxSize) {
        const transactions = this.getTransactions(maxSize);
        transactions.sort((a, b) => a.compareBlockOrder(b));
        return transactions;
    }

    /**
     * @param {Address} address
     * @return {Array.<Transaction>}
     */
    getWaitingTransactions(address) {
        if (this._transactionSetByAddress.contains(address)) {
            return this._transactionSetByAddress.get(address).transactions;
        } else {
            return [];
        }
    }

    /**
     * @fires Mempool#transactions-ready
     * @returns {Promise}
     * @private
     */
    _evictTransactions() {
        return this._synchronizer.push(() => this.__evictTransactions());
    }

    /**
     * @fires Mempool#transactions-ready
     * @returns {Promise}
     * @private
     */
    async __evictTransactions() {
        // Evict all transactions from the pool that have become invalid due
        // to changes in the account state (i.e. typically because the were included
        // in a newly mined block). No need to re-check signatures.
        for (const sender of this._transactionSetByAddress.keys()) {
            /** @type {MempoolTransactionSet} */ const set = this._transactionSetByAddress.get(sender);

            try {
                const senderAccount = await this._accounts.get(set.sender, set.senderType);
                while (!(await senderAccount.verifyOutgoingTransactionSet(set.transactions, this._blockchain.height + 1, true))) {
                    const transaction = set.shift();
                    if (transaction) {
                        this._transactionsByHash.remove(await transaction.hash());
                    }
                    if (set.length === 0) {
                        this._transactionSetByAddress.remove(sender);
                        break;
                    }
                }
            } catch (e) {
                let transaction;
                while ((transaction = set.shift())) {
                    this._transactionsByHash.remove(await transaction.hash());
                }
                this._transactionSetByAddress.remove(sender);
            }
        }

        // Tell listeners that the pool has updated after a blockchain head change.
        /**
         * @event Mempool#transactions-ready
         */
        this.fire('transactions-ready');
    }
}

Mempool.WAITING_TRANSACTIONS_PER_SENDER_MAX = 500;
Mempool.WAITING_TRANSACTION_SENDERS_MAX = 10000;
Mempool.WAITING_TRANSACTION_TIMEOUT = 30000;

Mempool.TRANSACTION_RELAY_FEE_MIN = 1; // sat/byte; transactions below that threshold are considered "free"
Mempool.FREE_TRANSACTIONS_PER_SENDER_MAX = 10; // max number of transactions considered free per sender

/** @enum {number} */
Mempool.ReturnCode = {
    FEE_TOO_LOW: -2,
    INVALID: -1,

    ACCEPTED: 1,
    KNOWN: 2
};

Class.register(Mempool);

/**
 * @abstract
 */
class BaseConsensusAgent extends Observable {
    /**
     * @param {Peer} peer
     */
    constructor(peer) {
        super();
        /** @type {Peer} */
        this._peer = peer;

        // Flag indicating that have synced our blockchain with the peer's.
        /** @type {boolean} */
        this._synced = false;

        // Set of all objects (InvVectors) that we think the remote peer knows.
        /** @type {HashSet.<InvVector>} */
        this._knownObjects = new HashSet();
        this._knownObjects.add(new InvVector(InvVector.Type.BLOCK, peer.headHash));

        // InvVectors we want to request via getData are collected here and
        // periodically requested.
        /** @type {HashSet.<InvVector>} */
        this._objectsToRequest = new HashSet();

        // Objects that are currently being requested from the peer.
        /** @type {HashSet.<InvVector>} */
        this._objectsInFlight = new HashSet();

        // All objects that were requested from the peer but not received yet.
        /** @type {HashSet.<InvVector>} */
        this._objectsThatFlew = new HashSet();

        // Objects that are currently being processed by the blockchain/mempool.
        /** @type {HashSet.<InvVector>} */
        this._objectsProcessing = new HashSet();

        // A Subscription object specifying which objects should be announced to the peer.
        // Initially, we don't announce anything to the peer until it tells us otherwise.
        /** @type {Subscription} */
        this._subscription = Subscription.NONE;

        // Helper object to keep track of timeouts & intervals.
        /** @type {Timers} */
        this._timers = new Timers();

        // Queue of transaction inv vectors waiting to be sent out
        /** @type {Queue.<InvVector>} */
        this._waitingInvVectors = new Queue();
        this._timers.setInterval('invVectors', () => this._sendWaitingInvVectors(), BaseConsensusAgent.TRANSACTION_RELAY_INTERVAL);
        // Queue of "free" transaction inv vectors waiting to be sent out
        /** @type {Queue.<{serializedSize:number, vector:InvVector}>} */
        this._waitingFreeInvVectors = new Queue();
        this._timers.setInterval('freeInvVectors', () => this._sendFreeWaitingInvVectors(), BaseConsensusAgent.FREE_TRANSACTION_RELAY_INTERVAL);

        // Listen to consensus messages from the peer.
        peer.channel.on('inv', msg => this._onInv(msg));
        peer.channel.on('block', msg => this._onBlock(msg));
        peer.channel.on('header', msg => this._onHeader(msg));
        peer.channel.on('tx', msg => this._onTx(msg));
        peer.channel.on('not-found', msg => this._onNotFound(msg));

        peer.channel.on('subscribe', msg => this._onSubscribe(msg));
        peer.channel.on('get-data', msg => this._onGetData(msg));
        peer.channel.on('get-header', msg => this._onGetHeader(msg));

        // Clean up when the peer disconnects.
        peer.channel.on('close', () => this._onClose());
    }

    /**
     * @param {Block} block
     * @returns {Promise.<boolean>}
     */
    async relayBlock(block) {
        // Don't relay block if have not synced with the peer yet.
        if (!this._synced) {
            return false;
        }

        // Only relay block if it matches the peer's subscription.
        if (!this._subscription.matchesBlock(block)) {
            return false;
        }

        // Create InvVector.
        const hash = await block.hash();
        const vector = new InvVector(InvVector.Type.BLOCK, hash);

        // Don't relay block to this peer if it already knows it.
        if (this._knownObjects.contains(vector)) {
            return false;
        }

        // Relay block to peer.
        this._peer.channel.inv([vector, ...this._waitingInvVectors.dequeueMulti(BaseInventoryMessage.VECTORS_MAX_COUNT - 1)]);

        // Assume that the peer knows this block now.
        this._knownObjects.add(vector);

        return true;
    }

    _sendWaitingInvVectors() {
        const invVectors = this._waitingInvVectors.dequeueMulti(BaseInventoryMessage.VECTORS_MAX_COUNT);
        if (invVectors.length > 0) {
            this._peer.channel.inv(invVectors);
            Log.v(BaseConsensusAgent, `[INV] Sent ${invVectors.length} vectors to ${this._peer.peerAddress}`);
        }
    }

    _sendFreeWaitingInvVectors() {
        const invVectors = [];
        let size = 0;
        while (invVectors.length <= BaseInventoryMessage.VECTORS_MAX_COUNT && this._waitingFreeInvVectors.length > 0
            && size < BaseConsensusAgent.FREE_TRANSACTION_SIZE_PER_INTERVAL) {
            const {serializedSize, vector} = this._waitingFreeInvVectors.dequeue();
            invVectors.push(vector);
            size += serializedSize;
        }
        if (invVectors.length > 0) {
            this._peer.channel.inv(invVectors);
            Log.v(BaseConsensusAgent, `[INV] Sent ${invVectors.length} vectors to ${this._peer.peerAddress}`);
        }
    }

    /**
     * @param {Transaction} transaction
     * @return {Promise.<boolean>}
     */
    async relayTransaction(transaction) {
        // Only relay transaction if it matches the peer's subscription.
        if (!this._subscription.matchesTransaction(transaction)) {
            return false;
        }

        // Create InvVector.
        const hash = await transaction.hash();
        const vector = new InvVector(InvVector.Type.TRANSACTION, hash);

        // Don't relay transaction to this peer if it already knows it.
        if (this._knownObjects.contains(vector)) {
            return false;
        }

        // Relay transaction to peer later.
        const serializedSize = transaction.serializedSize;
        if (transaction.fee/serializedSize < BaseConsensusAgent.TRANSACTION_RELAY_FEE_MIN) {
            this._waitingFreeInvVectors.enqueue({serializedSize, vector});
        } else {
            this._waitingInvVectors.enqueue(vector);
        }

        // Assume that the peer knows this transaction now.
        this._knownObjects.add(vector);

        return true;
    }

    /**
     * @param {Hash} blockHash
     * @returns {boolean}
     */
    knowsBlock(blockHash) {
        const vector = new InvVector(InvVector.Type.BLOCK, blockHash);
        return this._knownObjects.contains(vector);
    }

    /**
     * @param {SubscribeMessage} msg
     * @protected
     */
    _onSubscribe(msg) {
        Log.d(BaseConsensusAgent, `[SUBSCRIBE] ${this._peer.peerAddress} ${msg.subscription}`);
        this._subscription = msg.subscription;
    }

    /**
     * @param {InvMessage} msg
     * @returns {Promise.<void>}
     * @protected
     */
    async _onInv(msg) {
        // Keep track of the objects the peer knows.
        for (const vector of msg.vectors) {
            this._knownObjects.add(vector);
            this._waitingInvVectors.remove(vector);
        }

        // Check which of the advertised objects we know
        // Request unknown objects, ignore known ones.
        const unknownObjects = [];
        for (const vector of msg.vectors) {
            // Ignore objects that we are currently requesting / processing.
            if (this._objectsInFlight.contains(vector) || this._objectsProcessing.contains(vector)) {
                continue;
            }

            // Filter out objects that we are not interested in.
            if (!this._shouldRequestData(vector)) {
                continue;
            }

            switch (vector.type) {
                case InvVector.Type.BLOCK: {
                    const block = await this._getBlock(vector.hash, /*includeForks*/ true); // eslint-disable-line no-await-in-loop
                    if (!block) {
                        unknownObjects.push(vector);
                        this._onNewBlockAnnounced(vector.hash);
                    } else {
                        this._onKnownBlockAnnounced(vector.hash, block);
                    }
                    break;
                }
                case InvVector.Type.TRANSACTION: {
                    const transaction = await this._getTransaction(vector.hash); // eslint-disable-line no-await-in-loop
                    if (!transaction) {
                        unknownObjects.push(vector);
                        this._onNewTransactionAnnounced(vector.hash);
                    } else {
                        this._onKnownTransactionAnnounced(vector.hash, transaction);
                    }
                    break;
                }
                default:
                    throw `Invalid inventory type: ${vector.type}`;
            }
        }

        Log.v(BaseConsensusAgent, `[INV] ${msg.vectors.length} vectors (${unknownObjects.length} new) received from ${this._peer.peerAddress}`);

        if (unknownObjects.length > 0) {
            // Store unknown vectors in objectsToRequest.
            this._objectsToRequest.addAll(unknownObjects);

            // Clear the request throttle timeout.
            this._timers.clearTimeout('inv');

            // If there are enough objects queued up, send out a getData request.
            if (this._objectsToRequest.length >= BaseConsensusAgent.REQUEST_THRESHOLD) {
                this._requestData();
            }
            // Otherwise, wait a short time for more inv messages to arrive, then request.
            else {
                this._timers.setTimeout('inv', () => this._requestData(), BaseConsensusAgent.REQUEST_THROTTLE);
            }
        } else {
            this._onNoUnknownObjects();
        }
    }

    /**
     * @param {InvVector} vector
     * @returns {boolean}
     * @protected
     */
    _shouldRequestData(vector) {
        return true;
    }

    /**
     * @param {Hash} hash
     * @param {boolean} [includeForks]
     * @returns {Promise.<?Block>}
     * @protected
     * @abstract
     */
    _getBlock(hash, includeForks = false) {
        // MUST be implemented by subclasses.
        throw new Error('not implemented');
    }
    /**
     * @param {Hash} hash
     * @returns {Promise.<?Transaction>}
     * @protected
     * @abstract
     */
    _getTransaction(hash) {
        // MUST be implemented by subclasses.
        throw new Error('not implemented');
    }

    /**
     * @param {Hash} hash
     * @returns {void}
     * @protected
     */
    _onNewBlockAnnounced(hash) {
    }
    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {void}
     * @protected
     */
    _onKnownBlockAnnounced(hash, block) {
    }
    /**
     * @param {Hash} hash
     * @returns {void}
     * @protected
     */
    _onNewTransactionAnnounced(hash) {
    }
    /**
     * @param {Hash} hash
     * @param {Transaction} transaction
     * @returns {void}
     * @protected
     */
    _onKnownTransactionAnnounced(hash, transaction) {
    }

    /**
     * @returns {void}
     * @protected
     */
    _requestData() {
        // Only one request at a time.
        if (!this._objectsInFlight.isEmpty()) return;

        // Don't do anything if there are no objects queued to request.
        if (this._objectsToRequest.isEmpty()) return;

        // Request queued objects from the peer. Only request up to VECTORS_MAX_COUNT objects at a time.
        const vectorsMaxCount = BaseInventoryMessage.VECTORS_MAX_COUNT;
        /** @type {Array.<InvVector>} */
        const vectors = Array.from(new LimitIterable(this._objectsToRequest.valueIterator(), vectorsMaxCount));

        // Mark the requested objects as in-flight.
        this._objectsInFlight.addAll(vectors);

        // Remove requested objects from queue.
        this._objectsToRequest.removeAll(vectors);

        // Request data from peer.
        this._doRequestData(vectors);

        // Set timer to detect end of request / missing objects
        this._timers.setTimeout('getData', () => this._noMoreData(), BaseConsensusAgent.REQUEST_TIMEOUT);
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @returns {void}
     * @protected
     */
    _doRequestData(vectors) {
        this._peer.channel.getData(vectors);
    }

    /**
     * @param {BlockMessage} msg
     * @return {Promise.<void>}
     * @protected
     */
    async _onBlock(msg) {
        const hash = await msg.block.hash();

        // Check if we have requested this block.
        const vector = new InvVector(InvVector.Type.BLOCK, hash);
        if (!this._objectsInFlight.contains(vector) && !this._objectsThatFlew.contains(vector)) {
            Log.w(BaseConsensusAgent, `Unsolicited block ${hash} received from ${this._peer.peerAddress}, discarding`);
            return;
        }

        // Mark object as received.
        this._onObjectReceived(vector);

        // Process block.
        this._objectsProcessing.add(vector);
        await this._processBlock(hash, msg.block);

        // Mark object as processed.
        this._onObjectProcessed(vector);
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {Promise.<void>}
     * @protected
     */
    async _processBlock(hash, block) {
    }

    /**
     * @param {HeaderMessage} msg
     * @return {Promise.<void>}
     * @protected
     */
    async _onHeader(msg) {
        const hash = await msg.header.hash();

        // Check if we have requested this header.
        const vector = new InvVector(InvVector.Type.BLOCK, hash);
        if (!this._objectsInFlight.contains(vector) && !this._objectsThatFlew.contains(vector)) {
            Log.w(BaseConsensusAgent, `Unsolicited header ${hash} received from ${this._peer.peerAddress}, discarding`);
            return;
        }

        // Mark object as received.
        this._onObjectReceived(vector);

        // Process header.
        this._objectsProcessing.add(vector);
        await this._processHeader(hash, msg.header);

        // Mark object as processed.
        this._onObjectProcessed(vector);
    }

    /**
     * @param {Hash} hash
     * @param {BlockHeader} header
     * @returns {Promise.<void>}
     * @protected
     */
    async _processHeader(hash, header) {
    }

    /**
     * @param {TxMessage} msg
     * @return {Promise}
     * @protected
     */
    async _onTx(msg) {
        const hash = await msg.transaction.hash();
        //Log.d(BaseConsensusAgent, () => `[TX] Received transaction ${hash} from ${this._peer.peerAddress}`);

        // Check if we have requested this transaction.
        const vector = new InvVector(InvVector.Type.TRANSACTION, hash);
        if (!this._objectsInFlight.contains(vector) && !this._objectsThatFlew.contains(vector)) {
            Log.w(BaseConsensusAgent, `Unsolicited transaction ${hash} received from ${this._peer.peerAddress}, discarding`);
            return;
        }

        // Mark object as received.
        this._onObjectReceived(vector);

        // Process transaction.
        this._objectsProcessing.add(vector);
        await this._processTransaction(hash, msg.transaction);

        // Mark object as processed.
        this._onObjectProcessed(vector);
    }

    /**
     * @param {Hash} hash
     * @param {Transaction} transaction
     * @returns {Promise.<void>}
     * @protected
     */
    async _processTransaction(hash, transaction) {
    }

    /**
     * @param {NotFoundMessage} msg
     * @returns {void}
     * @protected
     */
    _onNotFound(msg) {
        Log.d(BaseConsensusAgent, `[NOTFOUND] ${msg.vectors.length} unknown objects received from ${this._peer.peerAddress}`);

        // Remove unknown objects from in-flight list.
        for (const vector of msg.vectors) {
            if (!this._objectsInFlight.contains(vector)) {
                continue;
            }

            // Mark object as received.
            this._onObjectReceived(vector);
        }
    }

    /**
     * @param {InvVector} vector
     * @returns {void}
     * @protected
     */
    _onObjectReceived(vector) {
        if (this._objectsInFlight.isEmpty()) return;

        // Remove the vector from objectsInFlight.
        this._objectsInFlight.remove(vector);

        // Reset the request timeout if we expect more objects to come.
        if (!this._objectsInFlight.isEmpty()) {
            this._timers.resetTimeout('getData', () => this._noMoreData(), BaseConsensusAgent.REQUEST_TIMEOUT);
        } else {
            this._noMoreData();
        }
    }

    /**
     * @returns {void}
     * @protected
     */
    _noMoreData() {
        // Cancel the request timeout timer.
        this._timers.clearTimeout('getData');

        // Reset objects in flight.
        this._objectsThatFlew.addAll(this._objectsInFlight.values());
        this._objectsInFlight.clear();

        // If there are more objects to request, request them.
        if (!this._objectsToRequest.isEmpty()) {
            this._requestData();
        } else {
            this._onAllObjectsReceived();
        }
    }

    /**
     * @returns {void}
     * @protected
     */
    _onNoUnknownObjects() {
    }

    /**
     * @returns {void}
     * @protected
     */
    _onAllObjectsReceived() {
    }

    /**
     * @param {InvVector} vector
     * @returns {void}
     * @protected
     */
    _onObjectProcessed(vector) {
        // Remove the vector from objectsProcessing.
        this._objectsProcessing.remove(vector);

        if (this._objectsProcessing.isEmpty()) {
            this._onAllObjectsProcessed();
        }
    }

    /**
     * @returns {void}
     * @protected
     */
    _onAllObjectsProcessed() {
    }

    /**
     * @param {GetDataMessage} msg
     * @returns {Promise}
     * @protected
     */
    async _onGetData(msg) {
        // Keep track of the objects the peer knows.
        for (const vector of msg.vectors) {
            this._knownObjects.add(vector);
        }

        // Check which of the requested objects we know.
        // Send back all known objects.
        // Send notFound for unknown objects.
        const unknownObjects = [];
        for (const vector of msg.vectors) {
            switch (vector.type) {
                case InvVector.Type.BLOCK: {
                    const block = await this._getBlock(vector.hash); // eslint-disable-line no-await-in-loop
                    if (block && block.isFull()) {
                        // We have found a requested block, send it back to the sender.
                        this._peer.channel.block(block);
                    } else {
                        // Requested block is unknown.
                        unknownObjects.push(vector);
                    }
                    break;
                }
                case InvVector.Type.TRANSACTION: {
                    const tx = await this._getTransaction(vector.hash); // eslint-disable-line no-await-in-loop
                    if (tx) {
                        // We have found a requested transaction, send it back to the sender.
                        this._peer.channel.tx(tx);
                    } else {
                        // Requested transaction is unknown.
                        unknownObjects.push(vector);
                    }
                    break;
                }
                default:
                    throw `Invalid inventory type: ${vector.type}`;
            }
        }

        // Report any unknown objects back to the sender.
        if (unknownObjects.length) {
            this._peer.channel.notFound(unknownObjects);
        }
    }

    /**
     * @param {GetHeaderMessage} msg
     * @returns {Promise}
     * @protected
     */
    async _onGetHeader(msg) {
        // Keep track of the objects the peer knows.
        for (const vector of msg.vectors) {
            this._knownObjects.add(vector);
        }

        // Check which of the requested objects we know.
        // Send back all known objects.
        // Send notFound for unknown objects.
        const unknownObjects = [];
        for (const vector of msg.vectors) {
            switch (vector.type) {
                case InvVector.Type.BLOCK: {
                    const block = await this._getBlock(vector.hash); // eslint-disable-line no-await-in-loop
                    if (block) {
                        // We have found a requested block, send it back to the sender.
                        this._peer.channel.header(block.header);
                    } else {
                        // Requested block is unknown.
                        unknownObjects.push(vector);
                    }
                    break;
                }
                case InvVector.Type.TRANSACTION:
                default:
                    throw `Invalid inventory type: ${vector.type}`;
            }
        }

        // Report any unknown objects back to the sender.
        if (unknownObjects.length) {
            this._peer.channel.notFound(unknownObjects);
        }
    }

    /**
     * @returns {void}
     * @protected
     */
    _onClose() {
        // Clear all timers and intervals when the peer disconnects.
        this._timers.clearAll();

        // Notify listeners that the peer has disconnected.
        this.fire('close', this);
    }

    /** @type {Peer} */
    get peer() {
        return this._peer;
    }

    /** @type {boolean} */
    get synced() {
        return this._synced;
    }
}
/**
 * Number of InvVectors in invToRequest pool to automatically trigger a getData request.
 * @type {number}
 */
BaseConsensusAgent.REQUEST_THRESHOLD = 50;
/**
 * Time (ms) to wait after the last received inv message before sending getData.
 * @type {number}
 */
BaseConsensusAgent.REQUEST_THROTTLE = 500;
/**
 * Maximum time (ms) to wait after sending out getData or receiving the last object for this request.
 * @type {number}
 */
BaseConsensusAgent.REQUEST_TIMEOUT = 1000 * 10;
/**
 * Time interval (ms) to wait between sending out transactions.
 * @type {number}
 */
BaseConsensusAgent.TRANSACTION_RELAY_INTERVAL = 5000;
/**
 * Time interval (ms) to wait between sending out "free" transactions.
 * @type {number}
 */
BaseConsensusAgent.FREE_TRANSACTION_RELAY_INTERVAL = 6000;
/**
 * Soft limit for the total size (bytes) of free transactions per relay interval.
 * @type {number}
 */
BaseConsensusAgent.FREE_TRANSACTION_SIZE_PER_INTERVAL = 15000; // ~100 legacy transactions
/**
 * Minimum fee per byte (sat/byte) such that a transaction is not considered free.
 * @type {number}
 */
BaseConsensusAgent.TRANSACTION_RELAY_FEE_MIN = 1;
Class.register(BaseConsensusAgent);

/**
 * An anchored, contiguous chain of full blocks.
 */
class FullChain extends BaseChain {
    /**
     * @param {JungleDB} jdb
     * @param {Accounts} accounts
     * @returns {Promise.<FullChain>}
     */
    static getPersistent(jdb, accounts) {
        const store = ChainDataStore.getPersistent(jdb);
        const chain = new FullChain(store, accounts);
        return chain._init();
    }

    /**
     * @param {Accounts} accounts
     * @returns {Promise.<FullChain>}
     */
    static createVolatile(accounts) {
        const store = ChainDataStore.createVolatile();
        const chain = new FullChain(store, accounts);
        return chain._init();
    }

    /**
     * @param {ChainDataStore} store
     * @param {Accounts} accounts
     * @returns {FullChain}
     */
    constructor(store, accounts) {
        super(store);
        this._accounts = accounts;

        /** @type {HashMap.<Hash,Accounts>} */
        this._snapshots = new HashMap();
        /** @type {Array.<Hash>} */
        this._snapshotOrder = [];

        /** @type {ChainData} */
        this._mainChain = null;

        /** @type {ChainProof} */
        this._proof = null;

        /**
         * @type {Synchronizer}
         * @private
         */
        this._synchronizer = new Synchronizer();
    }

    /**
     * @returns {Promise.<FullChain>}
     * @protected
     */
    async _init() {
        this._headHash = await this._store.getHead();
        if (this._headHash) {
            // Load main chain from store.
            this._mainChain = await this._store.getChainData(this._headHash);
            Assert.that(!!this._mainChain, 'Failed to load main chain from storage');

            // TODO Check if chain/accounts state is consistent!
            Assert.that(this._mainChain.head.accountsHash.equals(await this._accounts.hash()), 'Corrupted store: Inconsistent chain/accounts state');
        } else {
            // Initialize chain & accounts with Genesis block.
            this._mainChain = new ChainData(Block.GENESIS, Block.GENESIS.difficulty, BlockUtils.realDifficulty(await Block.GENESIS.pow()), true);
            this._headHash = Block.GENESIS.HASH;

            const tx = this._store.transaction();
            await tx.putChainData(Block.GENESIS.HASH, this._mainChain);
            await tx.setHead(Block.GENESIS.HASH);
            await tx.commit();

            await this._accounts.commitBlock(Block.GENESIS);
        }

        return this;
    }

    /**
     * @param {Block} block
     * @returns {Promise.<number>}
     */
    pushBlock(block) {
        return this._synchronizer.push(() => {
            return this._pushBlock(block);
        });
    }

    /**
     * @param {Block} block
     * @returns {Promise.<number>}
     * @protected
     */
    async _pushBlock(block) {
        // Check if we already know this block.
        const hash = await block.hash();
        const knownBlock = await this._store.getBlock(hash);
        if (knownBlock) {
            Log.v(FullChain, `Ignoring known block ${hash}`);
            return FullChain.OK_KNOWN;
        }

        // Check that the given block is a full block (includes block body).
        if (!block.isFull()) {
            Log.w(FullChain, 'Rejecting block - body missing');
            return FullChain.ERR_INVALID;
        }

        // Check all intrinsic block invariants.
        if (!(await block.verify())) {
            return FullChain.ERR_INVALID;
        }

        // Check that all known interlink blocks are valid predecessors of the given block.
        // if (!(await this._verifyInterlink(block))) {
        //     Log.w(FullChain, 'Rejecting block - interlink verification failed');
        //     return FullChain.ERR_INVALID;
        // }

        // Check if the block's immediate predecessor is part of the chain.
        /** @type {ChainData} */
        const prevData = await this._store.getChainData(block.prevHash);
        if (!prevData) {
            Log.w(FullChain, 'Rejecting block - unknown predecessor');
            return FullChain.ERR_ORPHAN;
        }

        // Check that the block is a valid successor of its immediate predecessor.
        const predecessor = prevData.head;
        if (!(await block.isImmediateSuccessorOf(predecessor))) {
            Log.w(FullChain, 'Rejecting block - not a valid immediate successor');
            return FullChain.ERR_INVALID;
        }

        // Check that the difficulty is correct.
        const nextTarget = await this.getNextTarget(predecessor);
        Assert.that(BlockUtils.isValidTarget(nextTarget), 'Failed to compute next target in FullChain');
        if (block.nBits !== BlockUtils.targetToCompact(nextTarget)) {
            Log.w(FullChain, 'Rejecting block - difficulty mismatch');
            return FullChain.ERR_INVALID;
        }

        // Block looks good, create ChainData.
        const totalDifficulty = prevData.totalDifficulty + block.difficulty;
        const totalWork = prevData.totalWork + BlockUtils.realDifficulty(await block.pow());
        const chainData = new ChainData(block, totalDifficulty, totalWork);

        // Check if the block extends our current main chain.
        if (block.prevHash.equals(this.headHash)) {
            // Append new block to the main chain.
            if (!(await this._extend(hash, chainData))) {
                return FullChain.ERR_INVALID;
            }
            return FullChain.OK_EXTENDED;
        }

        // Otherwise, check if the new chain is harder than our current main chain.
        if (totalDifficulty > this.totalDifficulty) {
            // A fork has become the hardest chain, rebranch to it.
            if (!(await this._rebranch(hash, chainData))) {
                return FullChain.ERR_INVALID;
            }
            return FullChain.OK_REBRANCHED;
        }

        // Otherwise, we are creating/extending a fork. Store chain data.
        Log.v(FullChain, `Creating/extending fork with block ${hash}, height=${block.height}, totalDifficulty=${chainData.totalDifficulty}, totalWork=${chainData.totalWork}`);
        await this._store.putChainData(hash, chainData);

        return FullChain.OK_FORKED;
    }

    /**
     * @param {Block} block
     * @returns {Promise.<boolean>}
     * @protected
     */
    async _verifyInterlink(block) {
        // Check that all blocks referenced in the interlink of the given block are valid predecessors of that block.
        // interlink[0] == Genesis is checked in Block.verify().
        for (let i = 1; i < block.interlink.length; i++) {
            const predecessor = await this._store.getBlock(block.interlink.hashes[i]); // eslint-disable-line no-await-in-loop
            if (!predecessor || !(await block.isInterlinkSuccessorOf(predecessor))) { // eslint-disable-line no-await-in-loop
                return false;
            }
        }
        return true;
    }


    /**
     * @param {Hash} blockHash
     * @param {ChainData} chainData
     * @returns {Promise.<boolean>}
     * @fires FullChain#head-changed
     * @private
     */
    async _extend(blockHash, chainData) {
        const accountsTx = await this._accounts.transaction();
        try {
            await accountsTx.commitBlock(chainData.head);
        } catch (e) {
            // AccountsHash mismatch. This can happen if someone gives us an invalid block.
            // TODO error handling
            Log.w(FullChain, `Rejecting block - failed to commit to AccountsTree: ${e.message || e}`);
            accountsTx.abort();
            return false;
        }

        chainData.onMainChain = true;

        const tx = await this._store.transaction();
        await tx.putChainData(blockHash, chainData);
        await tx.setHead(blockHash);
        await JDB.JungleDB.commitCombined(tx.tx, accountsTx.tx);

        // New block on main chain, so store a new snapshot.
        await this._saveSnapshot(blockHash);

        // Update chain proof if we have cached one.
        if (this._proof) {
            this._proof = await this._extendChainProof(this._proof, chainData.head.header);
        }

        // Update head.
        this._mainChain = chainData;
        this._headHash = blockHash;

        // Tell listeners that the head of the chain has changed.
        this.fire('head-changed', this.head, /*rebranching*/ false);

        return true;
    }

    /**
     * @param {Hash} blockHash
     * @param {ChainData} chainData
     * @returns {Promise.<boolean>}
     * @protected
     */
    async _rebranch(blockHash, chainData) {
        Log.v(FullChain, `Rebranching to fork ${blockHash}, height=${chainData.head.height}, totalDifficulty=${chainData.totalDifficulty}, totalWork=${chainData.totalWork}`);

        // Drop all snapshots.
        for (const hash of this._snapshotOrder) {
            const snapshot = this._snapshots.get(hash);
            snapshot.abort(); // We do not need to wait for the abortion as long as it has been triggered.
        }
        this._snapshots.clear();
        this._snapshotOrder = [];

        // Find the common ancestor between our current main chain and the fork chain.
        // Walk up the fork chain until we find a block that is part of the main chain.
        // Store the chain along the way.
        const forkChain = [];
        const forkHashes = [];

        let curData = chainData;
        let curHash = blockHash;
        while (!curData.onMainChain) {
            forkChain.push(curData);
            forkHashes.push(curHash);

            curHash = curData.head.prevHash;
            curData = await this._store.getChainData(curHash); // eslint-disable-line no-await-in-loop
            Assert.that(!!curData, 'Corrupted store: Failed to find fork predecessor while rebranching');
        }

        Log.v(FullChain, () => `Found common ancestor ${curHash.toBase64()} ${forkChain.length} blocks up`);

        // Validate all accountsHashes on the fork. Revert the AccountsTree to the common ancestor state first.
        const accountsTx = await this._accounts.transaction(false);
        let headHash = this._headHash;
        let head = this._mainChain.head;
        while (!headHash.equals(curHash)) {
            try {
                await accountsTx.revertBlock(head);
            } catch (e) {
                Log.e(FullChain, 'Failed to revert main chain while rebranching', e);
                accountsTx.abort();
                return false;
            }

            headHash = head.prevHash;
            head = await this._store.getBlock(headHash);
            Assert.that(!!head, 'Corrupted store: Failed to find main chain predecessor while rebranching');
            Assert.that(head.accountsHash.equals(await accountsTx.hash()), 'Failed to revert main chain - inconsistent state');
        }

        // Try to apply all fork blocks.
        for (let i = forkChain.length - 1; i >= 0; i--) {
            try {
                await accountsTx.commitBlock(forkChain[i].head);
            } catch (e) {
                // A fork block is invalid.
                // TODO delete invalid block and its successors from store.
                Log.e(FullChain, 'Failed to apply fork block while rebranching', e);
                accountsTx.abort();
                return false;
            }
        }

        // Fork looks good. Unset onMainChain flag on the current main chain up to (excluding) the common ancestor.
        const chainTx = this._store.transaction(false);
        headHash = this._headHash;
        let headData = this._mainChain;
        while (!headHash.equals(curHash)) {
            headData.onMainChain = false;
            await chainTx.putChainData(headHash, headData);

            headHash = headData.head.prevHash;
            headData = await chainTx.getChainData(headHash);
            Assert.that(!!headData, 'Corrupted store: Failed to find main chain predecessor while rebranching');
        }

        // Set onMainChain flag on the fork.
        for (let i = forkChain.length - 1; i >= 0; i--) {
            const forkData = forkChain[i];
            forkData.onMainChain = true;
            await chainTx.putChainData(forkHashes[i], forkData);
        }

        // Update head & commit transactions.
        await chainTx.setHead(blockHash);
        await JDB.JungleDB.commitCombined(chainTx.tx, accountsTx.tx);

        // Reset chain proof. We don't recompute the chain proof here, but do it lazily the next time it is needed.
        // TODO modify chain proof directly, don't recompute.
        this._proof = null;

        // Fire head-changed event for each fork block.
        for (let i = forkChain.length - 1; i >= 0; i--) {
            this._mainChain = forkChain[i];
            this._headHash = forkHashes[i];
            this.fire('head-changed', this.head, /*rebranching*/ i > 0);
        }

        return true;
    }

    /**
     *
     * @param {number} startHeight
     * @param {number} count
     * @param {boolean} forward
     * @returns {Promise.<Array.<Block>>}
     */
    getBlocks(startHeight, count = 500, forward = true) {
        return this._store.getBlocks(startHeight, count, forward);
    }

    /**
     * @returns {Promise.<ChainProof>}
     * @override
     */
    async getChainProof() {
        if (!this._proof) {
            this._proof = await this._getChainProof();
        }
        return this._proof;
    }

    /**
     * @param {Hash} blockHash
     * @param {string} startPrefix
     * @returns {Promise.<boolean|AccountsTreeChunk>}
     */
    async getAccountsTreeChunk(blockHash, startPrefix) {
        const snapshot = await this._getSnapshot(blockHash);
        return snapshot && await snapshot.getAccountsTreeChunk(startPrefix);
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<boolean|AccountsProof>}
     */
    async getAccountsProof(blockHash, addresses) {
        const snapshot = await this._getSnapshot(blockHash);
        return snapshot && await snapshot.getAccountsProof(addresses);
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<boolean|TransactionsProof>}
     */
    async getTransactionsProof(blockHash, addresses) {
        const block = await this.getBlock(blockHash);
        if (!block || !block.isFull()) {
            return false;
        }

        const matches = [];
        const addressesSet = new HashSet();
        addressesSet.addAll(addresses);
        for (const transaction of block.transactions) {
            if (addressesSet.contains(transaction.sender) || addressesSet.contains(transaction.recipient)) {
                matches.push(transaction);
            }
        }
        const proof = await MerkleProof.compute([block.minerAddr, block.body.extraData, ...block.transactions], matches);
        return new TransactionsProof(matches, proof);
    }

    /**
     * @param {Hash} blockHash
     * @returns {Promise.<boolean|Accounts>}
     */
    _getSnapshot(blockHash) {
        return this._synchronizer.push(async () => {
            const block = await this.getBlock(blockHash);
            // Check if blockHash is a block on the main chain within the allowed window.
            if (!block || this._mainChain.head.height - block.height > Policy.NUM_SNAPSHOTS_MAX) {
                return false;
            }

            // Check if there already is a snapshot, otherwise create it.
            let snapshot = null;
            if (!this._snapshots.contains(blockHash)) {
                const tx = await this._accounts.transaction();
                let currentHash = this._headHash;
                // Save all snapshots up to blockHash (and stop when its predecessor would be next).
                while (!block.prevHash.equals(currentHash)) {
                    const currentBlock = await this.getBlock(currentHash);

                    if (!this._snapshots.contains(currentHash)) {
                        snapshot = await this._accounts.snapshot(tx);
                        this._snapshots.put(currentHash, snapshot);
                        this._snapshotOrder.unshift(currentHash);
                    }

                    await tx.revertBlock(currentBlock);
                    currentHash = currentBlock.prevHash;
                }
                await tx.abort();
            } else {
                snapshot = this._snapshots.get(blockHash);
            }

            Assert.that(block.accountsHash.equals(await snapshot.hash()), 'AccountsHash mismatch for snapshot of block ${blockHash}');

            return snapshot;
        });
    }

    /**
     * @param {Hash} blockHash
     * @returns {Promise.<void>}
     * @private
     */
    async _saveSnapshot(blockHash) {
        // Replace oldest snapshot if possible.
        // This ensures snapshots are only created lazily.
        if (this._snapshotOrder.length > 0) {
            const oldestHash = this._snapshotOrder.shift();
            // If the hash is not reused, remove it.
            const oldestSnapshot = this._snapshots.get(oldestHash);
            if (oldestSnapshot) {
                await oldestSnapshot.abort();
            } else {
                Log.e(FullChain, () => `Snapshot with hash ${oldestHash.toBase64()} not found.`);
            }
            this._snapshots.remove(oldestHash);

            // Add new snapshot.
            const snapshot = await this._accounts.snapshot();
            this._snapshots.put(blockHash, snapshot);
            this._snapshotOrder.push(blockHash);
        }
    }

    /** @type {Block} */
    get head() {
        return this._mainChain.head;
    }

    /** @type {Hash} */
    get headHash() {
        return this._headHash;
    }

    get height() {
        return this._mainChain.head.height;
    }

    /** @type {number} */
    get totalDifficulty() {
        return this._mainChain.totalDifficulty;
    }

    /** @type {number} */
    get totalWork() {
        return this._mainChain.totalWork;
    }

    /** @type {Accounts} */
    // XXX Do we really want to expose this?
    get accounts() {
        return this._accounts;
    }

    /**
     * @returns {Promise.<Hash>}
     */
    // XXX Do we really want to expose this?
    accountsHash() {
        return this._accounts.hash();
    }
}
FullChain.ERR_ORPHAN = -2;
FullChain.ERR_INVALID = -1;
FullChain.OK_KNOWN = 0;
FullChain.OK_EXTENDED = 1;
FullChain.OK_REBRANCHED = 2;
FullChain.OK_FORKED = 3;
Class.register(FullChain);

class FullConsensusAgent extends BaseConsensusAgent {
    /**
     * @param {FullChain} blockchain
     * @param {Mempool} mempool
     * @param {Peer} peer
     */
    constructor(blockchain, mempool, peer) {
        super(peer);
        /** @type {FullChain} */
        this._blockchain = blockchain;
        /** @type {Mempool} */
        this._mempool = mempool;

        // Flag indicating that we are currently syncing our blockchain with the peer's.
        /** @type {boolean} */
        this._syncing = false;

        // The number of blocks that extended our blockchain since the last requestBlocks().
        /** @type {number} */
        this._numBlocksExtending = -1;
        // The number of blocks that forked our blockchain since the last requestBlocks().
        /** @type {number} */
        this._numBlocksForking = -1;
        // The last fork block the peer has sent us.
        /** @type {Block} */
        this._forkHead = null;

        // The number of failed blockchain sync attempts.
        /** @type {number} */
        this._failedSyncs = 0;

        // The block hash that we want to learn to consider the sync complete.
        /** @type {Hash} */
        this._syncTarget = peer.headHash;

        // Listen to consensus messages from the peer.
        peer.channel.on('get-blocks', msg => this._onGetBlocks(msg));
        peer.channel.on('get-chain-proof', msg => this._onGetChainProof(msg));
        peer.channel.on('get-accounts-proof', msg => this._onGetAccountsProof(msg));
        peer.channel.on('get-accounts-tree-chunk', msg => this._onGetAccountsTreeChunk(msg));
        peer.channel.on('get-transactions-proof', msg => this._onGetTransactionsProof(msg));
        peer.channel.on('mempool', msg => this._onMempool(msg));
    }

    async syncBlockchain() {
        this._syncing = true;

        // We only sync with other full nodes.
        if (!Services.isFullNode(this._peer.peerAddress.services)) {
            this._syncFinished();
            return;
        }

        // Wait for all objects to arrive.
        if (!this._objectsInFlight.isEmpty()) {
            Log.v(FullConsensusAgent, `Waiting for ${this._objectsInFlight.length} objects to arrive ...`);
            return;
        }

        // Wait for all objects to be processed.
        if (!this._objectsProcessing.isEmpty()) {
            Log.v(FullConsensusAgent, `Waiting for ${this._objectsProcessing.length} objects to be processed ...`);
            return;
        }

        // If we know our sync target block, the sync process is finished.
        const head = await this._blockchain.getBlock(this._syncTarget, /*includeForks*/ true);
        if (head) {
            this._syncFinished();
            return;
        }

        // If the peer didn't send us any blocks that extended our chain, count it as a failed sync attempt.
        // This sets a maximum length for forks that the full client will accept:
        //   FullConsensusAgent.SYNC_ATTEMPTS_MAX * BaseInvectoryMessage.VECTORS_MAX_COUNT
        if (this._numBlocksExtending === 0 && ++this._failedSyncs >= FullConsensusAgent.SYNC_ATTEMPTS_MAX) {
            this._peer.channel.ban('blockchain sync failed');
            return;
        }

        // We don't know the peer's head block, request blocks from it.
        this._requestBlocks();
    }

    _syncFinished() {
        // Subscribe to all announcements from the peer.
        this._peer.channel.subscribe(Subscription.ANY);

        // Request the peer's mempool.
        // XXX Use a random delay here to prevent requests to multiple peers at once.
        const delay = FullConsensusAgent.MEMPOOL_DELAY_MIN
            + Math.random() * (FullConsensusAgent.MEMPOOL_DELAY_MAX - FullConsensusAgent.MEMPOOL_DELAY_MIN);
        setTimeout(() => this._peer.channel.mempool(), delay);

        this._syncing = false;
        this._synced = true;

        this._numBlocksExtending = 0;
        this._numBlocksForking = 0;
        this._forkHead = null;
        this._failedSyncs = 0;

        this.fire('sync');
    }

    async _requestBlocks(maxInvSize) {
        // Only one getBlocks request at a time.
        if (this._timers.timeoutExists('getBlocks')) {
            Log.e(FullConsensusAgent, 'Duplicate _requestBlocks()');
            return;
        }

        // Drop the peer if it doesn't start sending InvVectors for its chain within the timeout.
        // Set timeout early to prevent re-entering the method.
        this._timers.setTimeout('getBlocks', () => {
            this._timers.clearTimeout('getBlocks');
            this._peer.channel.close('getBlocks timeout');
        }, BaseConsensusAgent.REQUEST_TIMEOUT);

        // Check if the peer is sending us a fork.
        const onFork = this._forkHead && this._numBlocksExtending === 0 && this._numBlocksForking > 0;

        /** @type {Array.<Hash>} */
        const locators = [];
        if (onFork) {
            // Only send the fork head as locator if the peer is sending us a fork.
            locators.push(await this._forkHead.hash());
        } else {
            // Request blocks starting from our hardest chain head going back to
            // the genesis block. Push top 10 hashes first, then back off exponentially.
            locators.push(this._blockchain.headHash);

            let block = this._blockchain.head;
            for (let i = Math.min(10, this._blockchain.height) - 1; i > 0; i--) {
                if (!block) {
                    break;
                }
                locators.push(block.prevHash);
                block = await this._blockchain.getBlock(block.prevHash); // eslint-disable-line no-await-in-loop
            }

            let step = 2;
            for (let i = this._blockchain.height - 10 - step; i > 0; i -= step) {
                block = await this._blockchain.getBlockAt(i); // eslint-disable-line no-await-in-loop
                if (block) {
                    locators.push(await block.hash()); // eslint-disable-line no-await-in-loop
                }
                step *= 2;
            }

            // Push the genesis block hash.
            if (locators.length === 0 || !locators[locators.length - 1].equals(Block.GENESIS.HASH)) {
                locators.push(Block.GENESIS.HASH);
            }
        }

        // Reset block counters.
        this._numBlocksExtending = 0;
        this._numBlocksForking = 0;

        // Request blocks from peer.
        this._peer.channel.getBlocks(locators, maxInvSize);
    }

    /**
     * @param {InvMessage} msg
     * @returns {Promise}
     * @protected
     * @override
     */
    _onInv(msg) {
        // Clear the getBlocks timeout.
        this._timers.clearTimeout('getBlocks');
        return super._onInv(msg);
    }

    /**
     * @param {InvVector} vector
     * @returns {boolean}
     * @protected
     * @override
     */
    _shouldRequestData(vector) {
        // Ignore block announcements from nano clients as they will ignore our getData requests anyways (they only know headers).
        return !(Services.isNanoNode(this._peer.peerAddress.services) && vector.type === InvVector.Type.BLOCK);
    }

    /**
     * @param {Hash} hash
     * @param {boolean} [includeForks]
     * @returns {Promise.<?Block>}
     * @protected
     * @override
     */
    _getBlock(hash, includeForks = false) {
        return this._blockchain.getBlock(hash, includeForks);
    }

    /**
     * @param {Hash} hash
     * @returns {Promise.<?Transaction>}
     * @protected
     * @override
     */
    _getTransaction(hash) {
        return Promise.resolve(this._mempool.getTransaction(hash));
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {void}
     * @protected
     * @override
     */
    async _onKnownBlockAnnounced(hash, block) {
        if (!this._syncing) return;

        // Check if this block is on a fork.
        const onFork = !(await this._getBlock(hash, /*includeForks*/ false));
        if (onFork) {
            this._numBlocksForking++;
            this._forkHead = block;
        }
    }

    /**
     * @returns {void}
     * @protected
     * @override
     */
    _onNoUnknownObjects() {
        // The peer does not have any new inv vectors for us.
        if (this._syncing) {
            this.syncBlockchain();
        }
    }

    /**
     * @protected
     * @override
     */
    _onAllObjectsReceived() {
        // If all objects have been received, request more if we're syncing the blockchain.
        if (this._syncing) {
            this.syncBlockchain();
        }
    }

    /**
     * @param {HeaderMessage} msg
     * @return {Promise.<void>}
     * @protected
     * @override
     */
    _onHeader(msg) {
        // Ignore header messages.
        Log.w(FullConsensusAgent, `Unsolicited header message received from ${this._peer.peerAddress}, discarding`);
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {Promise.<void>}
     * @protected
     * @override
     */
    async _processBlock(hash, block) {
        // TODO send reject message if we don't like the block
        const status = await this._blockchain.pushBlock(block);
        switch (status) {
            case FullChain.ERR_INVALID:
                this._peer.channel.ban('received invalid block');
                break;

            case FullChain.OK_EXTENDED:
            case FullChain.OK_REBRANCHED:
                if (this._syncing) this._numBlocksExtending++;
                break;

            case FullChain.OK_FORKED:
                if (this._syncing) {
                    this._numBlocksForking++;
                    this._forkHead = block;
                }
                break;

            case FullChain.ERR_ORPHAN:
                this._onOrphanBlock(hash, block);
                break;

            case FullChain.OK_KNOWN:
                Log.v(FullConsensusAgent, `Received known block ${hash} (height=${block.height}, prevHash=${block.prevHash}) from ${this._peer.peerAddress}`);
                break;
        }
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @protected
     */
    _onOrphanBlock(hash, block) {
        // Ignore orphan blocks if we're not synced yet. This shouldn't happen.
        if (!this._synced) {
            Log.w(FullConsensusAgent, `Received orphan block ${hash} (height=${block.height}, prevHash=${block.prevHash}) while syncing`);
            return;
        }

        // The peer has announced an orphaned block after the initial sync. We're probably out of sync.
        Log.d(FullConsensusAgent, `Received orphan block ${hash} (height=${block.height}, prevHash=${block.prevHash}) from ${this._peer.peerAddress}`);

        // Disable announcements from the peer once.
        if (!this._timers.timeoutExists('outOfSync')) {
            this._peer.channel.subscribe(Subscription.NONE);
        }

        // Set the orphaned block as the new sync target.
        this._syncTarget = hash;

        // Wait a short time for:
        // - our (un-)subscribe message to be sent
        // - potentially more orphaned blocks to arrive
        this._timers.resetTimeout('outOfSync', () => this._outOfSync(), FullConsensusAgent.RESYNC_THROTTLE);
    }

    /**
     * @private
     */
    _outOfSync() {
        this._timers.clearTimeout('outOfSync');

        this._synced = false;

        this.fire('out-of-sync');
    }

    /**
     * @param {Hash} hash
     * @param {Transaction} transaction
     * @returns {Promise.<boolean>}
     * @protected
     * @override
     */
    async _processTransaction(hash, transaction) {
        const result = await this._mempool.pushTransaction(transaction);
        return result === Mempool.ReturnCode.ACCEPTED;
    }

    /**
     * @protected
     * @override
     */
    _onAllObjectsProcessed() {
        // If all objects have been processed, request more if we're syncing the blockchain.
        if (this._syncing) {
            this.syncBlockchain();
        }
    }


    /* Request endpoints */

    /**
     * @param {GetBlocksMessage} msg
     * @return {Promise}
     * @private
     */
    async _onGetBlocks(msg) {
        Log.v(FullConsensusAgent, `[GETBLOCKS] ${msg.locators.length} block locators maxInvSize ${msg.maxInvSize} received from ${this._peer.peerAddress}`);

        // A peer has requested blocks. Check all requested block locator hashes
        // in the given order and pick the first hash that is found on our main
        // chain, ignore the rest. If none of the requested hashes is found,
        // pick the genesis block hash. Send the main chain starting from the
        // picked hash back to the peer.
        let startBlock = Block.GENESIS;
        for (const locator of msg.locators) {
            const block = await this._blockchain.getBlock(locator);
            if (block) {
                // We found a block, ignore remaining block locator hashes.
                startBlock = block;
                break;
            }
        }

        // Collect up to GETBLOCKS_VECTORS_MAX inventory vectors for the blocks starting right
        // after the identified block on the main chain.
        const blocks = await this._blockchain.getBlocks(startBlock.height + 1,
            Math.min(msg.maxInvSize, FullConsensusAgent.GETBLOCKS_VECTORS_MAX),
            msg.direction === GetBlocksMessage.Direction.FORWARD);
        const vectors = [];
        for (const block of blocks) {
            const hash = await block.hash();
            vectors.push(new InvVector(InvVector.Type.BLOCK, hash));
        }

        // Send the vectors back to the requesting peer.
        this._peer.channel.inv(vectors);
    }

    /**
     * @param {GetChainProofMessage} msg
     * @private
     */
    async _onGetChainProof(msg) {
        const proof = await this._blockchain.getChainProof();
        this._peer.channel.chainProof(proof);
    }

    /**
     * @param {GetAccountsProofMessage} msg
     * @private
     */
    async _onGetAccountsProof(msg) {
        const proof = await this._blockchain.getAccountsProof(msg.blockHash, msg.addresses);
        if (!proof) {
            this._peer.channel.rejectAccounts();
        } else {
            this._peer.channel.accountsProof(msg.blockHash, proof);
        }
    }

    /**
     * @param {GetTransactionsProofMessage} msg
     * @private
     */
    async _onGetTransactionsProof(msg) {
        const proof = await this._blockchain.getTransactionsProof(msg.blockHash, msg.addresses);
        if (!proof) {
            this._peer.channel.transactionsProof(msg.blockHash, [], await MerkleProof.compute([], []));
        } else {
            this._peer.channel.transactionsProof(msg.blockHash, proof);
        }
    }

    /**
     * @param {GetAccountsTreeChunkMessage} msg
     * @private
     */
    async _onGetAccountsTreeChunk(msg) {
        const chunk = await this._blockchain.getAccountsTreeChunk(msg.blockHash, msg.startPrefix);
        if (!chunk) {
            this._peer.channel.rejectAccounts();
        } else {
            this._peer.channel.accountsTreeChunk(msg.blockHash, chunk);
        }
    }

    /**
     * @param {MempoolMessage} msg
     * @return {Promise}
     * @private
     */
    async _onMempool(msg) {
        // Query mempool for transactions
        const allTransactions = this._mempool.getTransactions();
        const transactions = new LimitIterable(allTransactions, FullConsensusAgent.MEMPOOL_ENTRIES_MAX);

        // Send an InvVector for each transaction in the mempool.
        // Split into multiple Inv messages if the mempool is large.
        let vectors = [];
        for (const tx of transactions) {
            vectors.push(await InvVector.fromTransaction(tx));

            if (vectors.length >= BaseInventoryMessage.VECTORS_MAX_COUNT) {
                this._peer.channel.inv(vectors);
                vectors = [];
                await new Promise((resolve) => setTimeout(resolve, FullConsensusAgent.MEMPOOL_THROTTLE));
            }
        }

        if (vectors.length > 0) {
            this._peer.channel.inv(vectors);
        }
    }
}
/**
 * Maximum number of blockchain sync retries before closing the connection.
 * XXX If the peer is on a long fork, it will count as a failed sync attempt
 * if our blockchain doesn't switch to the fork within 500 (max InvVectors returned by getBlocks)
 * blocks.
 * @type {number}
 */
FullConsensusAgent.SYNC_ATTEMPTS_MAX = 10;
/**
 * Maximum number of inventory vectors to sent in the response for onGetBlocks.
 * @type {number}
 */
FullConsensusAgent.GETBLOCKS_VECTORS_MAX = 500;
/**
 * Time {ms} to wait before triggering a blockchain re-sync with the peer.
 * @type {number}
 */
FullConsensusAgent.RESYNC_THROTTLE = 1000 * 3; // 3 seconds
/**
 * Minimum time {ms} to wait before triggering the initial mempool request.
 * @type {number}
 */
FullConsensusAgent.MEMPOOL_DELAY_MIN = 1000 * 2; // 2 seconds
/**
 * Maximum time {ms} to wait before triggering the initial mempool request.
 * @type {number}
 */
FullConsensusAgent.MEMPOOL_DELAY_MAX = 1000 * 20; // 20 seconds
/**
 * Time {ms} to wait between sending full inv vectors of transactions during Mempool request
 * @type {number}
 */
FullConsensusAgent.MEMPOOL_THROTTLE = 1000;
/**
 * Number of transaction vectors to send
 * @type {number}
 */
FullConsensusAgent.MEMPOOL_ENTRIES_MAX = 10000;
Class.register(FullConsensusAgent);

class FullConsensus extends Observable {
    /**
     * @param {FullChain} blockchain
     * @param {Mempool} mempool
     * @param {Network} network
     */
    constructor(blockchain, mempool, network) {
        super();
        /** @type {FullChain} */
        this._blockchain = blockchain;
        /** @type {Mempool} */
        this._mempool = mempool;
        /** @type {Network} */
        this._network = network;

        /** @type {HashMap.<Peer, FullConsensusAgent>} */
        this._agents = new HashMap();

        /** @type {Timers} */
        this._timers = new Timers();

        /** @type {boolean} */
        this._established = false;

        /** @type {Peer} */
        this._syncPeer = null;

        network.on('peer-joined', peer => this._onPeerJoined(peer));
        network.on('peer-left', peer => this._onPeerLeft(peer));

        // Notify peers when our blockchain head changes.
        blockchain.on('head-changed', head => {
            // Don't announce head changes if we are not synced yet.
            if (!this._established) return;

            for (const agent of this._agents.values()) {
                agent.relayBlock(head);
            }
        });

        // Relay new (verified) transactions to peers.
        mempool.on('transaction-added', tx => {
            // Don't relay transactions if we are not synced yet.
            if (!this._established) return;

            for (const agent of this._agents.values()) {
                agent.relayTransaction(tx);
            }
        });
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerJoined(peer) {
        // Create a ConsensusAgent for each peer that connects.
        const agent = new FullConsensusAgent(this._blockchain, this._mempool, peer);
        this._agents.put(peer.id, agent);

        // Register agent event listeners.
        agent.on('close', () => this._onPeerLeft(agent.peer));
        agent.on('sync', () => this._onPeerSynced(agent.peer));
        agent.on('out-of-sync', () => this._onPeerOutOfSync(agent.peer));

        // If no more peers connect within the specified timeout, start syncing.
        this._timers.resetTimeout('sync', this._syncBlockchain.bind(this), FullConsensus.SYNC_THROTTLE);
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerLeft(peer) {
        // Reset syncPeer if it left during the sync.
        if (peer.equals(this._syncPeer)) {
            Log.w(FullConsensus, `Peer ${peer.peerAddress} left during sync`);
            this._syncPeer = null;
        }

        this._agents.remove(peer.id);
        this._syncBlockchain();
    }

    /**
     * @private
     */
    _syncBlockchain() {
        // Wait for ongoing sync to finish.
        if (this._syncPeer) {
            return;
        }

        // Choose a random peer which we aren't sync'd with yet.
        const agent = ArrayUtils.randomElement(this._agents.values().filter(agent => !agent.synced));
        if (!agent) {
            // We are synced with all connected peers.
            if (this._agents.length > 0) {
                // Report consensus-established if we have at least one connected peer.
                // TODO !!! Check peer types (at least one full node, etc.) !!!
                if (!this._established) {
                    Log.i(FullConsensus, `Synced with all connected peers (${this._agents.length}), consensus established.`);
                    Log.d(FullConsensus, `Blockchain: height=${this._blockchain.height}, headHash=${this._blockchain.headHash}`);

                    this._established = true;
                    this.fire('established');
                }
            } else {
                // We are not connected to any peers anymore. Report consensus-lost.
                this._established = false;
                this.fire('lost');
            }

            return;
        }

        this._syncPeer = agent.peer;

        // Notify listeners when we start syncing and have not established consensus yet.
        if (!this._established) {
            this.fire('syncing');
        }

        Log.v(FullConsensus, `Syncing blockchain with peer ${agent.peer.peerAddress}`);
        agent.syncBlockchain();
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerSynced(peer) {
        // Reset syncPeer if we finished syncing with it.
        if (peer.equals(this._syncPeer)) {
            Log.v(FullConsensus, `Finished sync with peer ${peer.peerAddress}`);
            this._syncPeer = null;
        }
        this._syncBlockchain();
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerOutOfSync(peer) {
        Log.w(FullConsensus, `Peer ${peer.peerAddress} out of sync, resyncing`);
        this._syncBlockchain();
    }

    /** @type {boolean} */
    get established() {
        return this._established;
    }

    /** @type {IBlockchain} */
    get blockchain() {
        return this._blockchain;
    }

    /** @type {Mempool} */
    get mempool() {
        return this._mempool;
    }

    /** @type {Network} */
    get network() {
        return this._network;
    }
}
FullConsensus.SYNC_THROTTLE = 1500; // ms
Class.register(FullConsensus);

/**
 * A LightChain is initialized by using NiPoPoWs instead of the full
 * blockchain history, but after initialization, it behaves as a regular
 * full blockchain.
 */
class LightChain extends FullChain {
    /**
    * @param {JungleDB} jdb
    * @param {Accounts} accounts
    * @returns {Promise.<LightChain>}
    */
    static getPersistent(jdb, accounts) {
        const store = ChainDataStore.getPersistent(jdb);
        const chain = new LightChain(store, accounts);
        return chain._init();
    }

    /**
     * @param {Accounts} accounts
     * @returns {Promise.<LightChain>}
     */
    static createVolatile(accounts) {
        const store = ChainDataStore.createVolatile();
        const chain = new LightChain(store, accounts);
        return chain._init();
    }

    /**
     * @param {ChainDataStore} store
     * @param {Accounts} accounts
     * @returns {PartialLightChain}
     */
    constructor(store, accounts) {
        super(store, accounts);
    }

    /**
     * @override
     * @protected
     */
    async _init() {
        // FIXME: this is a workaround as Babel doesn't understand await super().
        await FullChain.prototype._init.call(this);
        if (!this._proof) {
            this._proof = await this._getChainProof();
        }
        return this;
    }

    async partialChain() {
        const proof = await this.getChainProof();
        const partialChain = new PartialLightChain(this._store, this._accounts, proof);
        partialChain.on('committed', async (proof, headHash, mainChain) => {
            this._proof = proof;
            this._headHash = headHash;
            this._mainChain = mainChain;
            this.fire('head-changed', this.head);
        });
        await partialChain._init();
        return partialChain;
    }
}
Class.register(LightChain);

class LightConsensusAgent extends FullConsensusAgent {
    /**
     * @param {LightChain} blockchain
     * @param {Mempool} mempool
     * @param {Peer} peer
     */
    constructor(blockchain, mempool, peer) {
        super(blockchain, mempool, peer);
        /** @type {LightChain} */
        this._blockchain = blockchain;
        /** @type {PartialLightChain} */
        this._partialChain = null;

        /** @type {boolean} */
        this._syncing = false;

        // Flag indicating whether we do a full catchup or request a proof.
        /** @type {boolean} */
        this._catchup = false;

        // Flag indicating whether we believe to be on the main chain of the client.
        /** @type {boolean} */
        this._onMainChain = false;

        /** @type {Array.<Block>} */
        this._orphanedBlocks = [];

        /** @type {boolean} */
        this._busy = false;

        // Helper object to keep track of the accounts we're requesting from the peer.
        this._accountsRequest = null;

        // Listen to consensus messages from the peer.
        peer.channel.on('chain-proof', msg => this._onChainProof(msg));
        peer.channel.on('accounts-tree-chunk', msg => this._onAccountsTreeChunk(msg));
        peer.channel.on('accounts-rejected', msg => this._onAccountsRejected(msg));
    }

    /**
     * @returns {Promise.<void>}
     * @override
     */
    async syncBlockchain() {
        // We only sync with other full nodes.
        if (Services.isNanoNode(this._peer.peerAddress.services)) {
            this._syncFinished();
            return;
        }

        // Wait for all objects to arrive.
        if (!this._objectsInFlight.isEmpty()) {
            Log.v(LightConsensusAgent, `Waiting for ${this._objectsInFlight.length} objects to arrive ...`);
            return;
        }

        // Wait for all objects to be processed.
        if (!this._objectsProcessing.isEmpty()) {
            Log.v(LightConsensusAgent, `Waiting for ${this._objectsProcessing.length} objects to be processed ...`);
            return;
        }

        // Ban peer if the sync failed more often than allowed.
        if (this._failedSyncs >= LightConsensusAgent.SYNC_ATTEMPTS_MAX) {
            this._peer.channel.ban('blockchain sync failed');
            if (this._partialChain) {
                await this._partialChain.abort();
                this._partialChain = null;
            }
            return;
        }

        // Check if we know head block.
        const block = await this._blockchain.getBlock(this._syncTarget);

        /*
         * Three cases:
         * 1) We know block and are not yet syncing: All is done.
         * 2) We don't know the block and are not yet syncing: Start syncing.
         *    and determine sync mode (full catchup or not).
         * 3) We are syncing. Behave differently based on sync mode.
         *    Note that we can switch from catchup to proof if we notice that
         *    we're on a fork and get an INV vector starting from the genesis block.
         */

        // Case 1: We're up to date.
        if (block && !this._syncing) {
            this._syncFinished();
            return;
        }

        // Case 2: Check header.
        if (!block && !this._syncing) {
            this._syncing = true;
            this._onMainChain = false;

            let header;
            try {
                header = await this.getHeader(this._syncTarget);
            } catch(err) {
                this._peer.channel.close('Did not get requested header');
                return;
            }

            // Check how to sync based on heuristic:
            this._catchup = header.height - this._blockchain.height <= Policy.NUM_BLOCKS_VERIFICATION;
            Log.d(LightConsensusAgent, `Start syncing, catchup mode: ${this._catchup}`);
        }

        // Case 3: We are are syncing.
        if (this._syncing && !this._busy) {
            if (this._catchup) {
                await FullConsensusAgent.prototype.syncBlockchain.call(this);
            } else {
                // Initialize partial chain on first call.
                if (!this._partialChain) {
                    await this._initChainProofSync();
                }

                switch (this._partialChain.state) {
                    case PartialLightChain.State.PROVE_CHAIN:
                        this._requestChainProof();
                        this.fire('sync-chain-proof', this._peer.peerAddress);
                        break;
                    case PartialLightChain.State.PROVE_ACCOUNTS_TREE:
                        this._requestAccountsTree();
                        this.fire('sync-accounts-tree', this._peer.peerAddress);
                        break;
                    case PartialLightChain.State.PROVE_BLOCKS:
                        this._requestProofBlocks();
                        this.fire('verify-accounts-tree', this._peer.peerAddress);
                        break;
                    case PartialLightChain.State.COMPLETE:
                        // Commit state on success.
                        this.fire('sync-finalize', this._peer.peerAddress);
                        this._busy = true;
                        await this._partialChain.commit();
                        await this._applyOrphanedBlocks();
                        this._syncFinished();
                        break;
                    case PartialLightChain.State.ABORTED:
                        this._peer.channel.close('aborted sync');
                        break;
                }
            }
        }
    }

    /**
     * @returns {Promise.<void>}
     * @private
     */
    async _initChainProofSync() {
        // Subscribe to all announcements from the peer.
        this._peer.channel.subscribe(Subscription.ANY);

        this._syncing = true;
        this._synced = false;
        this._catchup = false;
        this._onMainChain = true;

        if (this._partialChain) {
            await this._partialChain.abort();
        }

        this._partialChain = await this._blockchain.partialChain();
    }

    /**
     * @returns {void}
     * @private
     */
    _syncFinished() {
        if (this._partialChain) {
            this._partialChain = null;
        }

        this._busy = false;
        super._syncFinished();
    }

    /**
     * @returns {Promise.<void>}
     * @private
     */
    async _applyOrphanedBlocks() {
        for (const block of this._orphanedBlocks) {
            const status = await this._blockchain.pushBlock(block);
            if (status === LightChain.ERR_INVALID) {
                this._peer.channel.ban('received invalid block');
                break;
            }
        }
        this._orphanedBlocks = [];
    }

    // Syncing stages.
    // Stage 1: Chain proof.
    /**
     * @returns {void}
     * @private
     */
    _requestChainProof() {
        Assert.that(this._partialChain && this._partialChain.state === PartialLightChain.State.PROVE_CHAIN);
        Assert.that(!this._timers.timeoutExists('getChainProof'));
        this._busy = true;

        // Request ChainProof from peer.
        this._peer.channel.getChainProof();

        // Drop the peer if it doesn't send the chain proof within the timeout.
        // TODO should we ban here instead?
        this._timers.setTimeout('getChainProof', () => {
            this._peer.channel.close('getChainProof timeout');
        }, LightConsensusAgent.CHAINPROOF_REQUEST_TIMEOUT);
    }

    /**
     * @param {ChainProofMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onChainProof(msg) {
        Assert.that(this._partialChain && this._partialChain.state === PartialLightChain.State.PROVE_CHAIN);
        Log.d(LightConsensusAgent, `[CHAIN-PROOF] Received from ${this._peer.peerAddress}: ${msg.proof}`);

        // Check if we have requested an interlink chain, reject unsolicited ones.
        if (!this._timers.timeoutExists('getChainProof')) {
            Log.w(LightConsensusAgent, `Unsolicited chain proof received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear timeout.
        this._timers.clearTimeout('getChainProof');

        if (this._syncing) {
            this.fire('verify-chain-proof', this._peer.peerAddress);
        }

        // Push the proof into the LightChain.
        if (!(await this._partialChain.pushProof(msg.proof))) {
            Log.w(LightConsensusAgent, `Invalid chain proof received from ${this._peer.peerAddress} - verification failed`);
            // TODO ban instead?
            this._peer.channel.close('invalid chain proof');
            return;
        }

        // TODO add all blocks from the chain proof to knownObjects.
        this._busy = false;
        this.syncBlockchain();
    }

    // Stage 2: Request AccountsTree.
    /**
     * @private
     */
    _requestAccountsTree() {
        Assert.that(this._partialChain && this._partialChain.state === PartialLightChain.State.PROVE_ACCOUNTS_TREE);
        Assert.that(!this._timers.timeoutExists('getAccountsTreeChunk'));
        this._busy = true;

        const startPrefix = this._partialChain.getMissingAccountsPrefix();
        const headHash = this._partialChain.headHash;
        Log.d(LightConsensusAgent, `Requesting AccountsTreeChunk starting at ${startPrefix} from ${this._peer.peerAddress}`);

        this._accountsRequest = {
            startPrefix: startPrefix,
            blockHash: headHash
        };

        // Request AccountsProof from peer.
        this._peer.channel.getAccountsTreeChunk(headHash, startPrefix);

        // Drop the peer if it doesn't send the accounts proof within the timeout.
        this._timers.setTimeout('getAccountsTreeChunk', () => {
            this._peer.channel.close('getAccountsTreeChunk timeout');
        }, LightConsensusAgent.ACCOUNTS_TREE_CHUNK_REQUEST_TIMEOUT);
    }

    /**
     * @param {AccountsTreeChunkMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onAccountsTreeChunk(msg) {
        Log.d(LightConsensusAgent, `[ACCOUNTS-TREE-CHUNK] Received from ${this._peer.peerAddress}: blockHash=${msg.blockHash}, proof=${msg.chunk}`);

        // Check if we have requested an accounts proof, reject unsolicited ones.
        if (!this._accountsRequest) {
            Log.w(LightConsensusAgent, `Unsolicited accounts tree chunk received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        Assert.that(this._partialChain && this._partialChain.state === PartialLightChain.State.PROVE_ACCOUNTS_TREE);

        // Clear the request timeout.
        this._timers.clearTimeout('getAccountsTreeChunk');

        const startPrefix = this._accountsRequest.startPrefix;
        const blockHash = this._accountsRequest.blockHash;

        // Reset accountsRequest.
        this._accountsRequest = null;

        // Check that we know the reference block.
        if (!blockHash.equals(msg.blockHash) || msg.chunk.head.prefix <= startPrefix) {
            Log.w(LightConsensusAgent, `Received AccountsTreeChunk for block != head or wrong start prefix from ${this._peer.peerAddress}`);
            this._peer.channel.close('Invalid AccountsTreeChunk');
            return;
        }

        // Verify the proof.
        const chunk = msg.chunk;
        if (!(await chunk.verify())) {
            Log.w(LightConsensusAgent, `Invalid AccountsTreeChunk received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('Invalid AccountsTreeChunk');
            return;
        }

        // Check that the proof root hash matches the accountsHash in the reference block.
        const rootHash = await chunk.root();
        const block = await this._partialChain.getBlock(blockHash);
        if (!block.accountsHash.equals(rootHash)) {
            Log.w(LightConsensusAgent, `Invalid AccountsTreeChunk (root hash) received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('AccountsTreeChunk root hash mismatch');
            return;
        }

        // Return the retrieved accounts.
        const result = await this._partialChain.pushAccountsTreeChunk(chunk);

        // Something went wrong!
        if (result < 0) {
            // TODO maybe ban?
            Log.e(`AccountsTree sync failed with error code ${result} from ${this._peer.peerAddress}`);
            this._peer.channel.close('AccountsTreeChunk root hash mismatch');
        }

        this._busy = false;
        this.syncBlockchain();
    }

    /**
     * @param {AccountsRejectedMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onAccountsRejected(msg) {
        Log.d(LightConsensusAgent, `[ACCOUNTS-REJECTED] Received from ${this._peer.peerAddress}`);

        // Check if we have requested an accounts proof, reject unsolicited ones.
        if (!this._accountsRequest) {
            Log.w(LightConsensusAgent, `Unsolicited accounts rejected received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getAccountsTreeChunk');

        // Reset accountsRequest.
        this._accountsRequest = null;

        // Restart syncing.
        await this._partialChain.abort();
        this._partialChain = null;
        this._busy = false;
        this._failedSyncs++;
    }

    // Stage 3: Request proof blocks.
    /**
     * @returns {Promise.<void>}
     * @private
     */
    async _requestProofBlocks() {
        Assert.that(this._partialChain && this._partialChain.state === PartialLightChain.State.PROVE_BLOCKS);

        // If nothing happend since the last request, increase failed syncs.
        if (this._lastChainHeight === this._partialChain.proofHeadHeight) {
            this._failedSyncs++;
        }
        this._lastChainHeight = this._partialChain.proofHeadHeight;

        // XXX Only one getBlocks request at a time.
        if (this._timers.timeoutExists('getBlocks')) {
            Log.e(LightConsensusAgent, 'Duplicate _requestProofBlocks()');
            return;
        }

        // Drop the peer if it doesn't start sending InvVectors for its chain within the timeout.
        // TODO should we ban here instead?
        this._timers.setTimeout('getBlocks', () => {
            this._timers.clearTimeout('getBlocks');
            this._peer.channel.close('getBlocks timeout');
        }, BaseConsensusAgent.REQUEST_TIMEOUT);

        // Request blocks from peer.
        this._peer.channel.getBlocks(await this._partialChain.getBlockLocators(), this._partialChain.numBlocksNeeded(), false);
    }

    // Block processing.
    /**
     * @returns {Promise.<void>}
     * @private
     */
    _requestBlocks() {
        // If we are syncing and not yet sure whether our blocks are on the main chain, just sync one block for now.
        if (this._syncing && !this._onMainChain) {
            return super._requestBlocks(1);
        }
        return super._requestBlocks();
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {Promise.<void>}
     * @protected
     * @override
     */
    async _processBlock(hash, block) {
        // If we find that we are on a fork far away from our chain, resync.
        if (block.height < this._chain.height - Policy.NUM_BLOCKS_VERIFICATION
            && (!this._partialChain || this._partialChain.state !== PartialLightChain.State.PROVE_BLOCKS)) {
            this._onMainChain = false;
            await this._initChainProofSync();
            this.syncBlockchain();
            return;
        } else {
            this._onMainChain = true;
        }

        // Put block into blockchain.
        const status = await this._chain.pushBlock(block);

        switch (status) {
            case FullChain.ERR_INVALID:
                this._peer.channel.ban('received invalid block');
                break;

            case FullChain.OK_EXTENDED:
            case FullChain.OK_REBRANCHED:
                if (this._syncing) this._numBlocksExtending++;
                break;

            case FullChain.OK_FORKED:
                if (this._syncing) {
                    this._numBlocksForking++;
                    this._forkHead = block;
                }
                break;

            case LightChain.ERR_ORPHAN:
                this._onOrphanBlock(hash, block);
                break;
        }
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @returns {void}
     * @protected
     * @override
     */
    async _onKnownBlockAnnounced(hash, block) {
        if (this._syncing && this._catchup) {
            // If we find that we are on a fork far away from our chain, resync.
            if (block.height < this._chain.height - Policy.NUM_BLOCKS_VERIFICATION
                && (!this._partialChain || this._partialChain.state !== PartialLightChain.State.PROVE_BLOCKS)) {
                this._onMainChain = false;
                await this._initChainProofSync();
                this.syncBlockchain().catch(e => Log.e(LightConsensusAgent, e));
                return;
            } else {
                this._onMainChain = true;
            }

            FullConsensusAgent.prototype._onKnownBlockAnnounced.call(this, hash, block);
        }
    }

    /**
     * @param {Hash} hash
     * @param {Block} block
     * @private
     * @override
     */
    _onOrphanBlock(hash, block) {
        if (this._syncing && !this._catchup) {
            this._orphanedBlocks.push(block);
        } else {
            super._onOrphanBlock(hash, block);
        }
    }

    // Header processing.
    /**
     * @param {Hash} hash
     * @return {Promise.<BlockHeader>}
     */
    getHeader(hash) {
        Assert.that(!this._headerRequest);

        return new Promise((resolve, reject) => {
            const vector = new InvVector(InvVector.Type.BLOCK, hash);
            this._headerRequest = {
                hash: hash,
                resolve: resolve,
                reject: reject
            };

            this._peer.channel.getHeader([vector]);

            // Drop the peer if it doesn't send the accounts proof within the timeout.
            this._timers.setTimeout('getHeader', () => {
                this._headerRequest = null;
                this._peer.channel.close('getHeader timeout');
                reject(new Error('timeout')); // TODO error handling
            }, BaseConsensusAgent.REQUEST_TIMEOUT);
        });
    }

    /**
     * @param {HeaderMessage} msg
     * @return {Promise.<void>}
     * @protected
     * @override
     */
    async _onHeader(msg) {
        const header = msg.header;
        const hash = await header.hash();

        // Check if we have requested this block.
        if (!this._headerRequest) {
            Log.w(NanoConsensusAgent, `Unsolicited header ${hash} received from ${this._peer.peerAddress}, discarding`);
            // TODO What should happen here? ban? drop connection?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getHeader');

        const requestedHash = this._headerRequest.hash;
        const resolve = this._headerRequest.resolve;
        const reject = this._headerRequest.reject;

        // Check that it is the correct hash.
        if (!requestedHash.equals(hash)) {
            Log.w(LightConsensusAgent, `Received wrong header from ${this._peer.peerAddress}`);
            this._peer.channel.close('Received wrong header');
            reject(new Error('Received wrong header'));
            return;
        }

        resolve(header);
    }

    /**
     * @returns {void}
     * @protected
     * @override
     */
    _onClose() {
        if (this._partialChain) {
            this._partialChain.abort();
        }

        super._onClose();
    }

    /** @type {LightChain} */
    get _chain() {
        if (this._syncing && !this._catchup && this._partialChain) {
            return this._partialChain;
        }
        return this._blockchain;
    }
}
/**
 * Maximum time (ms) to wait for chainProof after sending out getChainProof before dropping the peer.
 * @type {number}
 */
LightConsensusAgent.CHAINPROOF_REQUEST_TIMEOUT = 1000 * 20;
/**
 * Maximum time (ms) to wait for chainProof after sending out getChainProof before dropping the peer.
 * @type {number}
 */
LightConsensusAgent.ACCOUNTS_TREE_CHUNK_REQUEST_TIMEOUT = 1000 * 5;
/**
 * Maximum number of blockchain sync retries before closing the connection.
 * XXX If the peer is on a long fork, it will count as a failed sync attempt
 * if our blockchain doesn't switch to the fork within 500 (max InvVectors returned by getBlocks)
 * blocks.
 * @type {number}
 */
LightConsensusAgent.SYNC_ATTEMPTS_MAX = 5;
/**
 * Maximum number of inventory vectors to sent in the response for onGetBlocks.
 * @type {number}
 */
LightConsensusAgent.GETBLOCKS_VECTORS_MAX = 500;
Class.register(LightConsensusAgent);

class LightConsensus extends Observable {
    /**
     * @param {LightChain} blockchain
     * @param {Mempool} mempool
     * @param {Network} network
     */
    constructor(blockchain, mempool, network) {
        super();
        /** @type {LightChain} */
        this._blockchain = blockchain;
        /** @type {Mempool} */
        this._mempool = mempool;
        /** @type {Network} */
        this._network = network;

        /** @type {HashMap.<Peer, LightConsensusAgent>} */
        this._agents = new HashMap();

        /** @type {Timers} */
        this._timers = new Timers();

        /** @type {boolean} */
        this._established = false;

        /** @type {Peer} */
        this._syncPeer = null;

        /** @type {Synchronizer} */
        this._synchronizer = new Synchronizer();

        network.on('peer-joined', peer => this._onPeerJoined(peer));
        network.on('peer-left', peer => this._onPeerLeft(peer));

        // Notify peers when our blockchain head changes.
        blockchain.on('head-changed', head => {
            // Don't announce head changes if we are not synced yet.
            if (!this._established) return;

            for (const agent of this._agents.values()) {
                agent.relayBlock(head);
            }
        });

        // Relay new (verified) transactions to peers.
        mempool.on('transaction-added', tx => {
            // Don't relay transactions if we are not synced yet.
            if (!this._established) return;

            for (const agent of this._agents.values()) {
                agent.relayTransaction(tx);
            }
        });
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerJoined(peer) {
        // Create a ConsensusAgent for each peer that connects.
        const agent = new LightConsensusAgent(this._blockchain, this._mempool, peer);
        this._agents.put(peer.id, agent);

        // Register agent event listeners.
        agent.on('close', () => this._onPeerLeft(agent.peer));
        agent.on('sync', () => this._onPeerSynced(agent.peer));
        agent.on('out-of-sync', () => this._onPeerOutOfSync(agent.peer));

        this.bubble(agent, 'sync-chain-proof', 'verify-chain-proof', 'sync-accounts-tree', 'verify-accounts-tree', 'sync-finalize');

        // If no more peers connect within the specified timeout, start syncing.
        this._timers.resetTimeout('sync', this._syncBlockchain.bind(this), LightConsensus.SYNC_THROTTLE);
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerLeft(peer) {
        // Reset syncPeer if it left during the sync.
        if (peer.equals(this._syncPeer)) {
            Log.w(LightConsensus, `Peer ${peer.peerAddress} left during sync`);
            this._syncPeer = null;
            this.fire('sync-failed', peer.peerAddress);
        }

        this._agents.remove(peer.id);
        this._syncBlockchain();
    }

    /**
     * @private
     */
    _syncBlockchain() {
        return this._synchronizer.push(() => {
            // Wait for ongoing sync to finish.
            if (this._syncPeer) {
                return;
            }

            // Choose a random peer which we aren't sync'd with yet.
            const agents = this._agents.values().filter(agent => !agent.synced);
            const agent = ArrayUtils.randomElement(agents);
            if (!agent) {
                // We are synced with all connected peers.
                if (this._agents.length > 0) {
                    // Report consensus-established if we have at least one connected peer.
                    // TODO !!! Check peer types (at least one full node, etc.) !!!
                    if (!this._established) {
                        Log.i(LightConsensus, `Synced with all connected peers (${this._agents.length}), consensus established.`);
                        Log.d(LightConsensus, `Blockchain: height=${this._blockchain.height}, headHash=${this._blockchain.headHash}`);

                        this._established = true;
                        this.fire('established');
                    }
                } else {
                    // We are not connected to any peers anymore. Report consensus-lost.
                    this._established = false;
                    this.fire('lost');
                }

                return;
            }

            this._syncPeer = agent.peer;

            // Notify listeners when we start syncing and have not established consensus yet.
            if (!this._established) {
                this.fire('syncing', agent.peer.peerAddress, agents.length - 1);
            }

            Log.v(LightConsensus, `Syncing blockchain with peer ${agent.peer.peerAddress}`);
            agent.syncBlockchain();
        });
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerSynced(peer) {
        // Reset syncPeer if we finished syncing with it.
        if (peer.equals(this._syncPeer)) {
            Log.v(LightConsensus, `Finished sync with peer ${peer.peerAddress}`);
            this._syncPeer = null;
            this.fire('sync-finished', peer.peerAddress);
        }
        this._syncBlockchain();
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerOutOfSync(peer) {
        Log.w(LightConsensus, `Peer ${peer.peerAddress} out of sync, resyncing`);
        this._syncBlockchain();
    }

    /** @type {boolean} */
    get established() {
        return this._established;
    }

    /** @type {IBlockchain} */
    get blockchain() {
        return this._blockchain;
    }

    /** @type {Mempool} */
    get mempool() {
        return this._mempool;
    }

    /** @type {Network} */
    get network() {
        return this._network;
    }
}
LightConsensus.SYNC_THROTTLE = 1000; // ms
Class.register(LightConsensus);

class PartialLightChain extends LightChain {
    /**
     * @param {ChainDataStore} store
     * @param {Accounts} accounts
     * @param {ChainProof} proof
     * @returns {PartialLightChain}
     */
    constructor(store, accounts, proof) {
        const tx = store.transaction(false);
        super(tx, accounts);

        /** @type {ChainProof} */
        this._proof = proof;

        /** @type {PartialLightChain.State} */
        this._state = PartialLightChain.State.PROVE_CHAIN;
        /** @type {PartialAccountsTree} */
        this._partialTree = null;
        /** @type {Accounts} */
        this._accountsTx = null;
        /** @type {ChainData} */
        this._proofHead = null;
    }

    /**
     * @param {ChainProof} proof
     * @returns {Promise.<boolean>}
     */
    pushProof(proof) {
        return this._synchronizer.push(() => {
            return this._pushProof(proof);
        });
    }

    /**
     * @param {ChainProof} proof
     * @returns {Promise.<boolean>}
     * @private
     */
    async _pushProof(proof) {
        const toDo = [];
        for (let i = 0; i < proof.prefix.length; ++i) {
            const block = proof.prefix.blocks[i];
            const hash = await block.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (!knownBlock && !block.header._pow) {
                toDo.push(block.header);
            }
        }
        for (let i = 0; i < proof.suffix.length; ++i) {
            const header = proof.suffix.headers[i];
            const hash = await header.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (!knownBlock && !header._pow) {
                toDo.push(header);
            }
        }
        await Crypto.manyPow(toDo);

        // Verify all prefix blocks that we don't know yet.
        for (let i = 0; i < proof.prefix.length; i++) {
            const block = proof.prefix.blocks[i];
            const hash = await block.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (knownBlock) {
                proof.prefix.blocks[i] = knownBlock.toLight();
            } else if (!(await block.verify())) {
                Log.w(PartialLightChain, 'Rejecting proof - prefix contains invalid block');
                return false;
            }
        }

        // Verify all suffix headers that we don't know yet.
        for (let i = 0; i < proof.suffix.length; i++) {
            const header = proof.suffix.headers[i];
            const hash = await header.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (knownBlock) {
                proof.suffix.headers[i] = knownBlock.header;
            } else if (!(await header.verifyProofOfWork())) {
                Log.w(PartialLightChain, 'Rejecting proof - suffix contains invalid header');
                return false;
            }
        }

        // Check that the proof is valid.
        if (!(await proof.verify())) {
            Log.w(PartialLightChain, 'Rejecting proof - verification failed');
            return false;
        }

        // Check that the suffix is long enough.
        if (proof.suffix.length !== Policy.K && proof.suffix.length !== proof.head.height - 1) {
            Log.w(PartialLightChain, 'Rejecting proof - invalid suffix length');
            return false;
        }

        // Compute and verify interlinks for the suffix.
        const suffixBlocks = [];
        let head = proof.prefix.head;
        for (const header of proof.suffix.headers) {
            const interlink = await head.getNextInterlink(header.target, header.version);
            const interlinkHash = await interlink.hash();
            if (!header.interlinkHash.equals(interlinkHash)) {
                Log.w(PartialLightChain, 'Rejecting proof - invalid interlink hash in proof suffix');
                return false;
            }

            head = new Block(header, interlink);
            suffixBlocks.push(head);
        }

        // If the given proof is better than our current proof, adopt the given proof as the new best proof.
        const currentProof = await this.getChainProof();
        if (await BaseChain.isBetterProof(proof, currentProof, Policy.M)) {
            await this._acceptProof(proof, suffixBlocks);
        } else {
            await this.abort();
        }

        return true;
    }

    /**
     * @param {ChainProof} proof
     * @param {Array.<Block>} suffix
     * @returns {Promise.<void>}
     * @protected
     */
    async _acceptProof(proof, suffix) {
        // If the proof prefix head is not part of our current dense chain suffix, reset store and start over.
        // TODO use a store transaction here?
        const head = proof.prefix.head;
        const headHash = await head.hash();
        const headData = await this._store.getChainData(headHash);
        if (!headData || headData.totalDifficulty <= 0) {
            // Delete our current chain.
            await this._store.truncate();

            /** @type {Array.<Block>} */
            const denseSuffix = await proof.prefix.denseSuffix();

            // Put all other prefix blocks in the store as well (so they can be retrieved via getBlock()/getBlockAt()),
            // but don't allow blocks to be appended to them by setting totalDifficulty = -1;
            for (let i = 0; i < proof.prefix.length - denseSuffix.length; i++) {
                const block = proof.prefix.blocks[i];
                const hash = await block.hash();
                const data = new ChainData(block, /*totalDifficulty*/ -1, /*totalWork*/ -1, true);
                await this._store.putChainData(hash, data);
            }

            // Set the tail end of the dense suffix of the prefix as the new chain head.
            const tailEnd = denseSuffix[0];
            this._headHash = await tailEnd.hash();
            this._mainChain = new ChainData(tailEnd, tailEnd.difficulty, BlockUtils.realDifficulty(await tailEnd.pow()), true);
            await this._store.putChainData(this._headHash, this._mainChain);

            // Only in the dense suffix of the prefix we can calculate the difficulties.
            for (let i = 1; i < denseSuffix.length; i++) {
                const block = denseSuffix[i];
                const result = await this._pushLightBlock(block); // eslint-disable-line no-await-in-loop
                Assert.that(result >= 0);
            }
        }

        // Push all suffix blocks.
        for (const block of suffix) {
            const result = await this._pushLightBlock(block, false); // eslint-disable-line no-await-in-loop
            Assert.that(result >= 0);
        }

        this._state = PartialLightChain.State.PROVE_ACCOUNTS_TREE;
        this._partialTree = await this._accounts.partialAccountsTree();
        this._proofHead = this._mainChain;
        await this._store.setHead(this.headHash);

        this._proof = proof;
    }

    async _pushLightBlock(block) {
        // Check if we already know this header/block.
        const hash = await block.hash();
        const knownBlock = await this._store.getBlock(hash);
        if (knownBlock) {
            return NanoChain.OK_KNOWN;
        }

        // Retrieve the immediate predecessor.
        /** @type {ChainData} */
        const prevData = await this._store.getChainData(block.prevHash);
        if (!prevData || prevData.totalDifficulty <= 0) {
            return NanoChain.ERR_ORPHAN;
        }

        return this._pushBlockInternal(block, hash, prevData);
    }

    async _pushBlockInternal(block, blockHash, prevData) {
        // Block looks good, create ChainData.
        const totalDifficulty = prevData.totalDifficulty + block.difficulty;
        const totalWork = prevData.totalWork + BlockUtils.realDifficulty(await block.pow());
        const chainData = new ChainData(block, totalDifficulty, totalWork);

        // Check if the block extends our current main chain.
        if (block.prevHash.equals(this.headHash)) {
            // Append new block to the main chain.
            chainData.onMainChain = true;
            await this._store.putChainData(blockHash, chainData);

            // Update head.
            this._mainChain = chainData;
            this._headHash = blockHash;

            // Append new block to chain proof.
            if (this._proof) {
                const proofHeadHash = await this._proof.head.hash();
                if (block.prevHash.equals(proofHeadHash)) {
                    this._proof = await this._extendChainProof(this._proof, block.header);
                }
            }

            // Tell listeners that the head of the chain has changed.
            this.fire('head-changed', this.head, /*rebranching*/ false);

            return NanoChain.OK_EXTENDED;
        }

        // Otherwise, check if the new chain is harder than our current main chain.
        if (totalDifficulty > this._mainChain.totalDifficulty) {
            // A fork has become the hardest chain, rebranch to it.
            await this._rebranch(blockHash, chainData);

            return NanoChain.OK_REBRANCHED;
        }

        // Otherwise, we are creating/extending a fork. Store chain data.
        Log.v(NanoChain, `Creating/extending fork with block ${blockHash}, height=${block.height}, totalDifficulty=${chainData.totalDifficulty}, totalWork=${chainData.totalWork}`);
        await this._store.putChainData(blockHash, chainData);

        return NanoChain.OK_FORKED;
    }

    /**
     * @override
     * @param {Block} block
     * @returns {Promise.<number>}
     */
    async _pushBlock(block) {
        // Queue new blocks while syncing.
        if (this._state === PartialLightChain.State.PROVE_BLOCKS) {
            const blockHash = await block.hash();
            if (this._proofHead.head.prevHash.equals(blockHash)) {
                return this._pushBlockBackwards(block);
            } else if ((await this._proofHead.head.hash()).equals(blockHash)) {
                return this._pushHeadBlock(block);
            }
        }

        return FullChain.ERR_ORPHAN;
    }

    /**
     * @param {Block} block
     * @returns {Promise.<number>}
     * @private
     */
    async _pushHeadBlock(block) {
        // Check if we already know this block.
        const hash = await block.hash();

        // Check that the given block is a full block (includes block body).
        if (!block.isFull()) {
            Log.w(PartialLightChain, 'Rejecting block - body missing');
            return FullChain.ERR_INVALID;
        }

        // Check all intrinsic block invariants.
        if (!(await block.verify())) {
            return FullChain.ERR_INVALID;
        }

        // Check that all known interlink blocks are valid predecessors of the given block.
        if (!(await this._verifyInterlink(block))) {
            Log.w(PartialLightChain, 'Rejecting block - interlink verification failed');
            return FullChain.ERR_INVALID;
        }

        // We know that the current proof head is the successor.
        // Check that the block is a valid predecessor of its immediate successor.
        const prevData = await this._store.getChainData(block.prevHash);
        if (!prevData) {
            Log.w(PartialLightChain, 'Rejecting block - unknown predecessor');
            return FullChain.ERR_ORPHAN;
        }

        // Check that the block is a valid successor of its immediate predecessor.
        const predecessor = prevData.head;
        if (!(await block.isImmediateSuccessorOf(predecessor))) {
            Log.w(PartialLightChain, 'Rejecting block - not a valid immediate successor');
            return FullChain.ERR_INVALID;
        }

        // Check that the difficulty is correct.
        const nextTarget = await this.getNextTarget(predecessor);
        if (BlockUtils.isValidTarget(nextTarget)) {
            if (block.nBits !== BlockUtils.targetToCompact(nextTarget)) {
                Log.w(PartialLightChain, 'Rejecting block - difficulty mismatch');
                return FullChain.ERR_INVALID;
            }
        } else {
            Log.w(PartialLightChain, 'Skipping difficulty verification - not enough blocks available');
        }

        // Block looks good, create ChainData.
        const totalDifficulty = prevData.totalDifficulty + block.difficulty;
        const totalWork = prevData.totalWork + BlockUtils.realDifficulty(await block.pow());
        const chainData = new ChainData(block, totalDifficulty, totalWork);

        // Prepend new block to the main chain.
        if (!(await this._prepend(hash, chainData))) {
            return FullChain.ERR_INVALID;
        }

        this._mainChain = chainData;
        this._proofHead = chainData; // So now it is a full block.
        this._headHash = hash;

        // Check whether we're complete.
        if (!this.needsMoreBlocks()) {
            await this._complete();
        }

        return FullChain.OK_EXTENDED;
    }

    /**
     * @param {Block} block
     * @returns {Promise.<number>}
     * @private
     */
    async _pushBlockBackwards(block) {
        // Check if we already know this block.
        const hash = await block.hash();

        // Check that the given block is a full block (includes block body).
        if (!block.isFull()) {
            Log.w(PartialLightChain, 'Rejecting block - body missing');
            return FullChain.ERR_INVALID;
        }

        // Check all intrinsic block invariants.
        if (!(await block.verify())) {
            return FullChain.ERR_INVALID;
        }

        // Check that all known interlink blocks are valid predecessors of the given block.
        if (!(await this._verifyInterlink(block))) {
            Log.w(PartialLightChain, 'Rejecting block - interlink verification failed');
            return FullChain.ERR_INVALID;
        }

        // We know that the current proof head is the successor.
        // Check that the block is a valid predecessor of its immediate successor.
        if (!(await this._proofHead.head.isImmediateSuccessorOf(block))) {
            Log.w(PartialLightChain, 'Rejecting block - not a valid immediate predecessor');
            return FullChain.ERR_INVALID;
        }

        // Check that the difficulty is correct.
        const nextTarget = await this.getNextTarget(block);
        if (BlockUtils.isValidTarget(nextTarget)) {
            if (this._proofHead.head.nBits !== BlockUtils.targetToCompact(nextTarget)) {
                Log.w(PartialLightChain, 'Rejecting block - difficulty mismatch');
                return FullChain.ERR_INVALID;
            }
        } else {
            Log.w(NanoChain, 'Skipping difficulty verification - not enough blocks available');
        }

        // Block looks good, create ChainData.
        const totalDifficulty = this._proofHead.totalDifficulty - this._proofHead.head.difficulty;
        const totalWork = this._proofHead.totalWork - BlockUtils.realDifficulty(await this._proofHead.head.pow());
        const chainData = new ChainData(block, totalDifficulty, totalWork);

        // Prepend new block to the main chain.
        if (!(await this._prepend(hash, chainData))) {
            return FullChain.ERR_INVALID;
        }

        return FullChain.OK_EXTENDED;
    }

    /**
     * @param {Hash} blockHash
     * @param {ChainData} chainData
     * @returns {Promise.<boolean>}
     * @private
     */
    async _prepend(blockHash, chainData) {
        try {
            await this._accountsTx.revertBlock(chainData.head);
        } catch (e) {
            // AccountsHash mismatch. This can happen if someone gives us an invalid block.
            // TODO error handling
            Log.w(PartialLightChain, `Rejecting block - failed to commit to AccountsTree: ${e.message || e}`);
            return false;
        }

        chainData.onMainChain = true;

        await this._store.putChainData(blockHash, chainData);

        this._proofHead = chainData;

        // Check whether we're complete.
        if (!this.needsMoreBlocks()) {
            await this._complete();
        }

        return true;
    }

    /**
     * @param {AccountsTreeChunk} chunk
     * @returns {Promise.<PartialAccountsTree.Status>}
     */
    async pushAccountsTreeChunk(chunk) {
        if (this._state !== PartialLightChain.State.PROVE_ACCOUNTS_TREE) {
            return PartialAccountsTree.Status.ERR_INCORRECT_PROOF;
        }

        const result = await this._partialTree.pushChunk(chunk);

        // If we're done, prepare next phase.
        if (result === PartialAccountsTree.Status.OK_COMPLETE) {
            this._state = PartialLightChain.State.PROVE_BLOCKS;
            this._accountsTx = new Accounts(await this._partialTree.transaction(false));
        }

        return result;
    }

    /**
     * @returns {Promise.<void>}
     * @private
     */
    async _complete() {
        this._state = PartialLightChain.State.COMPLETE;
        if (this._accountsTx) {
            await this._accountsTx.abort();
            this._accountsTx = null;
        }

        const currentProof = await this.getChainProof();
        this.fire('complete', currentProof, this._headHash, this._mainChain);
    }

    /**
     * @returns {Promise.<boolean>}
     */
    async commit() {
        if (this._accountsTx) {
            await this._accountsTx.abort();
        }

        const result = await JDB.JungleDB.commitCombined(this._store.tx, this._partialTree.tx);
        this._partialTree = null;

        const currentProof = await this.getChainProof();
        this.fire('committed', currentProof, this._headHash, this._mainChain);

        return result;
    }

    /**
     * @returns {Promise.<void>}
     */
    async abort() {
        this._state = PartialLightChain.State.ABORTED;
        if (this._accountsTx) {
            await this._accountsTx.abort();
        }
        if (this._partialTree) {
            await this._partialTree.abort();
        }
        await this._store.abort();
        this.fire('aborted');
    }

    /**
     * @returns {string}
     */
    getMissingAccountsPrefix() {
        if (this._partialTree) {
            return this._partialTree.missingPrefix;
        }
        return '';
    }

    /**
     * @returns {Promise.<Array.<Hash>>}
     */
    async getBlockLocators() {
        return this._proofHead ? [await this._proofHead.head.hash()] : [this.headHash];
    }

    /**
     * @returns {number}
     */
    numBlocksNeeded() {
        if (!this._proofHead) {
            return Policy.NUM_BLOCKS_VERIFICATION;
        }
        let numBlocks = Policy.NUM_BLOCKS_VERIFICATION - (this.height - this._proofHead.head.height + 1);
        // If we begin syncing, we need one block additionally.
        if (!this._proofHead.head.isFull()) {
            numBlocks++;
        }
        return numBlocks;
    }

    /**
     * @returns {boolean}
     */
    needsMoreBlocks() {
        return this.numBlocksNeeded() > 0;
    }

    /** @type {PartialLightChain.State} */
    get state() {
        return this._state;
    }

    /** @type {number} */
    get proofHeadHeight() {
        return this._proofHead.head.height;
    }
}
/**
 * @enum {number}
 */
PartialLightChain.State = {
    ABORTED: -1,
    PROVE_CHAIN: 0,
    PROVE_ACCOUNTS_TREE: 1,
    PROVE_BLOCKS: 2,
    COMPLETE: 3
};
Class.register(PartialLightChain);

class NanoChain extends BaseChain {
    /**
     * @returns {Promise.<NanoChain>}
     */
    constructor() {
        super(ChainDataStore.createVolatile());

        this._proof = new ChainProof(new BlockChain([Block.GENESIS.toLight()]), new HeaderChain([]));

        this._headHash = Block.GENESIS.HASH;

        this._synchronizer = new Synchronizer();

        return this._init();
    }

    async _init() {
        this._mainChain = new ChainData(Block.GENESIS, Block.GENESIS.difficulty, BlockUtils.realDifficulty(await Block.GENESIS.pow()), true);
        await this._store.putChainData(Block.GENESIS.HASH, this._mainChain);

        return this;
    }

    /**
     * @param {ChainProof} proof
     * @returns {Promise.<boolean>}
     */
    pushProof(proof) {
        return this._synchronizer.push(() => {
            return this._pushProof(proof);
        });
    }

    /**
     * @param {ChainProof} proof
     * @returns {Promise.<boolean>}
     * @private
     */
    async _pushProof(proof) {
        const toDo = [];
        for (let i = 0; i < proof.prefix.length; ++i) {
            const block = proof.prefix.blocks[i];
            const hash = await block.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (!knownBlock && !block.header._pow) {
                toDo.push(block.header);
            }
        }
        for (let i = 0; i < proof.suffix.length; ++i) {
            const header = proof.suffix.headers[i];
            const hash = await header.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (!knownBlock && !header._pow) {
                toDo.push(header);
            }
        }
        await Crypto.manyPow(toDo);

        // Verify all prefix blocks that we don't know yet.
        for (let i = 0; i < proof.prefix.length; i++) {
            const block = proof.prefix.blocks[i];
            const hash = await block.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (knownBlock) {
                proof.prefix.blocks[i] = knownBlock.toLight();
            } else if (!(await block.verify())) {
                Log.w(NanoChain, 'Rejecting proof - prefix contains invalid block');
                return false;
            }
        }

        // Verify all suffix headers that we don't know yet.
        for (let i = 0; i < proof.suffix.length; i++) {
            const header = proof.suffix.headers[i];
            const hash = await header.hash();
            const knownBlock = await this._store.getBlock(hash);
            if (knownBlock) {
                proof.suffix.headers[i] = knownBlock.header;
            } else if (!(await header.verifyProofOfWork())) {
                Log.w(NanoChain, 'Rejecting proof - suffix contains invalid header');
                return false;
            }
        }

        // Check that the proof is valid.
        if (!(await proof.verify())) {
            Log.w(NanoChain, 'Rejecting proof - verification failed');
            return false;
        }

        // Check that the suffix is long enough.
        if (proof.suffix.length !== Policy.K && proof.suffix.length !== proof.head.height - 1) {
            Log.w(NanoChain, 'Rejecting proof - invalid suffix length');
            return false;
        }

        // Compute and verify interlinks for the suffix.
        const suffixBlocks = [];
        let head = proof.prefix.head;
        for (const header of proof.suffix.headers) {
            const interlink = await head.getNextInterlink(header.target, header.version);
            const interlinkHash = await interlink.hash();
            if (!header.interlinkHash.equals(interlinkHash)) {
                Log.w(NanoChain, 'Rejecting proof - invalid interlink hash in proof suffix');
                return false;
            }

            head = new Block(header, interlink);
            suffixBlocks.push(head);
        }

        // If the given proof is better than our current proof, adopt the given proof as the new best proof.
        const currentProof = await this.getChainProof();
        if (await BaseChain.isBetterProof(proof, currentProof, Policy.M)) {
            await this._acceptProof(proof, suffixBlocks);
        }

        return true;
    }

    /**
     * @param {ChainProof} proof
     * @param {Array.<Block>} suffix
     * @returns {Promise.<void>}
     * @private
     */
    async _acceptProof(proof, suffix) {
        this._proof = proof;

        // If the proof prefix head is not part of our current dense chain suffix, reset store and start over.
        // TODO use a store transaction here?
        const head = proof.prefix.head;
        const headHash = await head.hash();
        const headData = await this._store.getChainData(headHash);
        if (!headData || headData.totalDifficulty <= 0) {
            // Delete our current chain.
            await this._store.truncate();

            /** @type {Array.<Block>} */
            const denseSuffix = await proof.prefix.denseSuffix();

            // Put all other prefix blocks in the store as well (so they can be retrieved via getBlock()/getBlockAt()),
            // but don't allow blocks to be appended to them by setting totalDifficulty = -1;
            for (let i = 0; i < proof.prefix.length - denseSuffix.length; i++) {
                const block = proof.prefix.blocks[i];
                const hash = await block.hash();
                const data = new ChainData(block, /*totalDifficulty*/ -1, /*totalWork*/ -1, true);
                await this._store.putChainData(hash, data);
            }

            // Set the tail end of the dense suffix of the prefix as the new chain head.
            const tailEnd = denseSuffix[0];
            this._headHash = await tailEnd.hash();
            this._mainChain = new ChainData(tailEnd, tailEnd.difficulty, BlockUtils.realDifficulty(await tailEnd.pow()), true);
            await this._store.putChainData(this._headHash, this._mainChain);

            // Only in the dense suffix of the prefix we can calculate the difficulties.
            for (let i = 1; i < denseSuffix.length; i++) {
                const block = denseSuffix[i];
                const result = await this._pushBlock(block); // eslint-disable-line no-await-in-loop
                Assert.that(result >= 0);
            }
        }

        // Push all suffix blocks.
        for (const block of suffix) {
            const result = await this._pushBlock(block); // eslint-disable-line no-await-in-loop
            Assert.that(result >= 0);
        }
    }

    async _pushBlock(block) {
        // Check if we already know this header/block.
        const hash = await block.hash();
        const knownBlock = await this._store.getBlock(hash);
        if (knownBlock) {
            return NanoChain.OK_KNOWN;
        }

        // Retrieve the immediate predecessor.
        /** @type {ChainData} */
        const prevData = await this._store.getChainData(block.prevHash);
        if (!prevData || prevData.totalDifficulty <= 0) {
            return NanoChain.ERR_ORPHAN;
        }

        return this._pushBlockInternal(block, hash, prevData);
    }

    /**
     * @param {BlockHeader} header
     * @returns {Promise.<number>}
     */
    pushHeader(header) {
        return this._synchronizer.push(() => {
            return this._pushHeader(header);
        });
    }

    /**
     * @param {BlockHeader} header
     * @returns {Promise.<number>}
     * @private
     */
    async _pushHeader(header) {
        // Check if we already know this header/block.
        const hash = await header.hash();
        const knownBlock = await this._store.getBlock(hash);
        if (knownBlock) {
            return NanoChain.OK_KNOWN;
        }

        // Verify proof of work.
        if (!(await header.verifyProofOfWork())) {
            Log.w(NanoChain, 'Rejecting header - PoW verification failed');
            return NanoChain.ERR_INVALID;
        }

        // Retrieve the immediate predecessor.
        /** @type {ChainData} */
        const prevData = await this._store.getChainData(header.prevHash);
        if (!prevData || prevData.totalDifficulty <= 0) {
            Log.w(NanoChain, 'Rejecting header - unknown predecessor');
            return NanoChain.ERR_ORPHAN;
        }

        // Check that the block is valid successor to its predecessor.
        /** @type {Block} */
        const predecessor = prevData.head;
        if (!(await header.isImmediateSuccessorOf(predecessor.header))) {
            Log.w(NanoChain, 'Rejecting header - not a valid successor');
            return NanoChain.ERR_INVALID;
        }

        // Check that the difficulty is correct (if we can compute the next target)
        const nextTarget = await this.getNextTarget(predecessor);
        if (BlockUtils.isValidTarget(nextTarget)) {
            if (header.nBits !== BlockUtils.targetToCompact(nextTarget)) {
                Log.w(NanoChain, 'Rejecting header - difficulty mismatch');
                return NanoChain.ERR_INVALID;
            }
        } else {
            Log.w(NanoChain, 'Skipping difficulty verification - not enough blocks available');
        }

        // Compute and verify interlink.
        const interlink = await predecessor.getNextInterlink(header.target, header.version);
        const interlinkHash = await interlink.hash();
        if (!interlinkHash.equals(header.interlinkHash)) {
            Log.w(NanoChain, 'Rejecting header - interlink verification failed');
            return NanoChain.ERR_INVALID;
        }

        const block = new Block(header, interlink);
        return this._pushBlockInternal(block, hash, prevData);
    }

    /**
     * @param {Block} block
     * @param {Hash} blockHash
     * @param {ChainData} prevData
     * @returns {Promise.<number>}
     * @private
     */
    async _pushBlockInternal(block, blockHash, prevData) {
        // Block looks good, create ChainData.
        const totalDifficulty = prevData.totalDifficulty + block.difficulty;
        const totalWork = prevData.totalWork + BlockUtils.realDifficulty(await block.pow());
        const chainData = new ChainData(block, totalDifficulty, totalWork);

        // Check if the block extends our current main chain.
        if (block.prevHash.equals(this.headHash)) {
            // Append new block to the main chain.
            chainData.onMainChain = true;
            await this._store.putChainData(blockHash, chainData);

            // Update head.
            this._mainChain = chainData;
            this._headHash = blockHash;

            // Append new block to chain proof.
            if (this._proof) {
                const proofHeadHash = await this._proof.head.hash();
                if (block.prevHash.equals(proofHeadHash)) {
                    this._proof = await this._extendChainProof(this._proof, block.header);
                }
            }

            // Tell listeners that the head of the chain has changed.
            this.fire('head-changed', this.head, /*rebranching*/ false);

            return NanoChain.OK_EXTENDED;
        }

        // Otherwise, check if the new chain is harder than our current main chain.
        if (totalDifficulty > this._mainChain.totalDifficulty) {
            // A fork has become the hardest chain, rebranch to it.
            await this._rebranch(blockHash, chainData);

            return NanoChain.OK_REBRANCHED;
        }

        // Otherwise, we are creating/extending a fork. Store chain data.
        Log.v(NanoChain, `Creating/extending fork with block ${blockHash}, height=${block.height}, totalDifficulty=${chainData.totalDifficulty}, totalWork=${chainData.totalWork}`);
        await this._store.putChainData(blockHash, chainData);

        return NanoChain.OK_FORKED;
    }

    /**
     * @param {Hash} blockHash
     * @param {ChainData} chainData
     * @returns {Promise}
     * @private
     */
    async _rebranch(blockHash, chainData) {
        Log.v(NanoChain, `Rebranching to fork ${blockHash}, height=${chainData.head.height}, totalDifficulty=${chainData.totalDifficulty}, totalWork=${chainData.totalWork}`);

        // Find the common ancestor between our current main chain and the fork chain.
        // Walk up the fork chain until we find a block that is part of the main chain.
        // Store the chain along the way.
        const forkChain = [];
        const forkHashes = [];

        let curData = chainData;
        let curHash = blockHash;
        while (!curData.onMainChain) {
            forkChain.push(curData);
            forkHashes.push(curHash);

            curHash = curData.head.prevHash;
            curData = await this._store.getChainData(curHash); // eslint-disable-line no-await-in-loop
            Assert.that(!!curData, 'Failed to find fork predecessor while rebranching');
        }

        Log.v(NanoChain, () => `Found common ancestor ${curHash.toBase64()} ${forkChain.length} blocks up`);

        // Unset onMainChain flag on the current main chain up to (excluding) the common ancestor.
        let headHash = this._headHash;
        let headData = this._mainChain;
        while (!headHash.equals(curHash)) {
            headData.onMainChain = false;
            await this._store.putChainData(headHash, headData);

            headHash = headData.head.prevHash;
            headData = await this._store.getChainData(headHash);
            Assert.that(!!headData, 'Failed to find main chain predecessor while rebranching');
        }

        // Reset chain proof. We don't recompute the chain proof here, but do it lazily the next time it is needed.
        // TODO modify chain proof directly, don't recompute.
        this._proof = null;

        // Set onMainChain flag on the fork.
        for (let i = forkChain.length - 1; i >= 0; i--) {
            const forkData = forkChain[i];
            forkData.onMainChain = true;
            await this._store.putChainData(forkHashes[i], forkData);

            // Fire head-changed event for each fork block.
            this._mainChain = forkChain[i];
            this._headHash = forkHashes[i];
            this.fire('head-changed', this.head, /*rebranching*/ i > 0);
        }
    }

    /**
     * @returns {Promise.<ChainProof>}
     * @override
     */
    async getChainProof() {
        if (!this._proof) {
            this._proof = await this._getChainProof();
        }
        return this._proof;
    }

    /** @type {Block} */
    get head() {
        return this._mainChain.head;
    }

    /** @type {Hash} */
    get headHash() {
        return this._headHash;
    }

    /** @type {number} */
    get height() {
        return this._mainChain.head.height;
    }
}
NanoChain.ERR_ORPHAN = -2;
NanoChain.ERR_INVALID = -1;
NanoChain.OK_KNOWN = 0;
NanoChain.OK_EXTENDED = 1;
NanoChain.OK_REBRANCHED = 2;
NanoChain.OK_FORKED = 3;
Class.register(NanoChain);

class NanoConsensusAgent extends BaseConsensusAgent {
    /**
     * @param {NanoChain} blockchain
     * @param {NanoMempool} mempool
     * @param {Peer} peer
     */
    constructor(blockchain, mempool, peer) {
        super(peer);
        /** @type {NanoChain} */
        this._blockchain = blockchain;
        /** @type {NanoMempool} */
        this._mempool = mempool;

        // Flag indicating that we are currently syncing our blockchain with the peer's.
        /** @type {boolean} */
        this._syncing = false;

        /** @type {Array.<BlockHeader>} */
        this._orphanedBlocks = [];

        /** @type {Synchronizer} */
        this._synchronizer = new Synchronizer();

        // Helper object to keep track of the accounts we're requesting from the peer.
        this._accountsRequest = null;

        // Helper object to keep track of the transactions we're requesting from the peer.
        this._transactionsRequest = null;

        // Helper object to keep track of full blocks we're requesting from the peer.
        this._blockRequest = null;

        // Listen to consensus messages from the peer.
        peer.channel.on('chain-proof', msg => this._onChainProof(msg));
        peer.channel.on('accounts-proof', msg => this._onAccountsProof(msg));
        peer.channel.on('accounts-rejected', msg => this._onAccountsRejected(msg));
        peer.channel.on('transactions-proof', msg => this._onTransactionsProof(msg));

        peer.channel.on('get-chain-proof', msg => this._onGetChainProof(msg));

        // Subscribe to all announcements from the peer.
        this._peer.channel.subscribe(Subscription.ANY);
    }

    /**
     * @returns {Promise.<void>}
     */
    async syncBlockchain() {
        this._syncing = true;

        const headBlock = await this._blockchain.getBlock(this._peer.headHash);
        if (!headBlock) {
            this._requestChainProof();
            this.fire('sync-chain-proof', this._peer.peerAddress);
        } else {
            this._syncFinished();
        }
    }

    /**
     * @returns {void}
     * @private
     */
    _syncFinished() {
        this._syncing = false;
        this._synced = true;
        this.fire('sync');
    }

    /**
     * @returns {void}
     * @private
     */
    _requestChainProof() {
        // Only one chain proof request at a time.
        if (this._timers.timeoutExists('getChainProof')) {
            return;
        }

        // Request ChainProof from peer.
        this._peer.channel.getChainProof();

        // Drop the peer if it doesn't send the chain proof within the timeout.
        // TODO should we ban here instead?
        this._timers.setTimeout('getChainProof', () => {
            this._peer.channel.close('getChainProof timeout');
        }, NanoConsensusAgent.CHAINPROOF_REQUEST_TIMEOUT);
    }

    /**
     * @param {ChainProofMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onChainProof(msg) {
        Log.d(NanoConsensusAgent, `[CHAIN-PROOF] Received from ${this._peer.peerAddress}: ${msg.proof}`);

        // Check if we have requested an interlink chain, reject unsolicited ones.
        if (!this._timers.timeoutExists('getChainProof')) {
            Log.w(NanoConsensusAgent, `Unsolicited chain proof received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear timeout.
        this._timers.clearTimeout('getChainProof');

        if (this._syncing) {
            this.fire('verify-chain-proof', this._peer.peerAddress);
        }

        // Push the proof into the NanoChain.
        if (!(await this._blockchain.pushProof(msg.proof))) {
            Log.w(NanoConsensusAgent, `Invalid chain proof received from ${this._peer.peerAddress} - verification failed`);
            // TODO ban instead?
            this._peer.channel.close('invalid chain proof');
            return;
        }

        // TODO add all blocks from the chain proof to knownObjects.

        // Apply any orphaned blocks we received while waiting for the chain proof.
        await this._applyOrphanedBlocks();

        if (this._syncing) {
            this._syncFinished();
        }
    }

    /**
     * @returns {Promise.<void>}
     * @private
     */
    async _applyOrphanedBlocks() {
        for (const header of this._orphanedBlocks) {
            const status = await this._blockchain.pushHeader(header);
            if (status === NanoChain.ERR_INVALID) {
                this._peer.channel.ban('received invalid block');
                break;
            }
        }
        this._orphanedBlocks = [];
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @returns {void}
     * @protected
     * @override
     */
    _doRequestData(vectors) {
        /** @type {Array.<InvVector>} */
        const blocks = [];
        /** @type {Array.<InvVector>} */
        const transactions = [];
        for (const vector of vectors) {
            if (vector.type === InvVector.Type.BLOCK) {
                blocks.push(vector);
            } else {
                transactions.push(vector);
            }
        }

        // Request headers and transactions from peer.
        this._peer.channel.getHeader(blocks);
        this._peer.channel.getData(transactions);
    }

    /**
     * @param {Hash} hash
     * @param {boolean} [includeForks]
     * @returns {Promise.<?Block>}
     * @protected
     * @override
     */
    _getBlock(hash, includeForks = false) {
        return this._blockchain.getBlock(hash, includeForks);
    }

    /**
     * @param {Hash} hash
     * @returns {Promise.<?Transaction>}
     * @protected
     * @override
     */
    _getTransaction(hash) {
        return Promise.resolve(this._mempool.getTransaction(hash));
    }

    /**
     * @param {Hash} hash
     * @param {BlockHeader} header
     * @returns {Promise.<void>}
     * @protected
     * @override
     */
    async _processHeader(hash, header) {
        // TODO send reject message if we don't like the block
        const status = await this._blockchain.pushHeader(header);
        if (status === NanoChain.ERR_INVALID) {
            this._peer.channel.ban('received invalid header');
        }
        // Re-sync with this peer if it starts sending orphan blocks after the initial sync.
        else if (status === NanoChain.ERR_ORPHAN) {
            this._orphanedBlocks.push(header);
            if (this._synced) {
                this._requestChainProof();
            }
        }
    }

    /**
     * @param {Hash} hash
     * @param {Transaction} transaction
     * @returns {Promise.<void>}
     * @protected
     * @override
     */
    _processTransaction(hash, transaction) {
        // TODO send reject message if we don't like the transaction
        return this._mempool.pushTransaction(transaction);
    }

    /**
     * @param {GetChainProofMessage} msg
     * @private
     */
    async _onGetChainProof(msg) {
        const proof = await this._blockchain.getChainProof();
        if (proof) {
            this._peer.channel.chainProof(proof);
        }
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<Array.<Account>>}
     */
    getAccounts(blockHash, addresses) {
        return this._synchronizer.push(() => {
            return this._getAccounts(blockHash, addresses);
        });
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<Array<Account>>}
     * @private
     */
    _getAccounts(blockHash, addresses) {
        Assert.that(this._accountsRequest === null);

        Log.d(NanoConsensusAgent, `Requesting AccountsProof for ${addresses} from ${this._peer.peerAddress}`);

        return new Promise((resolve, reject) => {
            this._accountsRequest = {
                addresses: addresses,
                blockHash: blockHash,
                resolve: resolve,
                reject: reject
            };

            // Request AccountsProof from peer.
            this._peer.channel.getAccountsProof(blockHash, addresses);

            // Drop the peer if it doesn't send the accounts proof within the timeout.
            this._timers.setTimeout('getAccountsProof', () => {
                this._peer.channel.close('getAccountsProof timeout');
                reject(new Error('timeout')); // TODO error handling
            }, NanoConsensusAgent.ACCOUNTSPROOF_REQUEST_TIMEOUT);
        });
    }

    /**
     * @param {AccountsProofMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onAccountsProof(msg) {
        Log.d(NanoConsensusAgent, `[ACCOUNTS-PROOF] Received from ${this._peer.peerAddress}: blockHash=${msg.blockHash}, proof=${msg.proof} (${msg.serializedSize} bytes)`);

        // Check if we have requested an accounts proof, reject unsolicited ones.
        if (!this._accountsRequest) {
            Log.w(NanoConsensusAgent, `Unsolicited accounts proof received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getAccountsProof');

        const addresses = this._accountsRequest.addresses;
        const blockHash = this._accountsRequest.blockHash;
        const resolve = this._accountsRequest.resolve;
        const reject = this._accountsRequest.reject;

        // Reset accountsRequest.
        this._accountsRequest = null;

        // Check that the reference block corresponds to the one we requested.
        if (!blockHash.equals(msg.blockHash)) {
            Log.w(NanoConsensusAgent, `Received AccountsProof for invalid reference block from ${this._peer.peerAddress}`);
            reject(new Error('Invalid reference block'));
            return;
        }

        // Verify the proof.
        const proof = msg.proof;
        if (!(await proof.verify())) {
            Log.w(NanoConsensusAgent, `Invalid AccountsProof received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('Invalid AccountsProof');
            reject(new Error('Invalid AccountsProof'));
            return;
        }

        // Check that the proof root hash matches the accountsHash in the reference block.
        const rootHash = await proof.root();
        const block = await this._blockchain.getBlock(blockHash);
        if (!block.accountsHash.equals(rootHash)) {
            Log.w(NanoConsensusAgent, `Invalid AccountsProof (root hash) received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('AccountsProof root hash mismatch');
            reject(new Error('AccountsProof root hash mismatch'));
            return;
        }

        // Check that all requested accounts are part of this proof.
        // XXX return a map address -> account instead?
        const accounts = [];
        for (const address of addresses) {
            try {
                const account = proof.getAccount(address);
                accounts.push(account);
            } catch (e) {
                Log.w(NanoConsensusAgent, `Incomplete AccountsProof received from ${this._peer.peerAddress}`);
                // TODO ban instead?
                this._peer.channel.close('Incomplete AccountsProof');
                reject(new Error('Incomplete AccountsProof'));
                return;
            }
        }

        // Return the retrieved accounts.
        resolve(accounts);
    }

    /**
     * @param {AccountsRejectedMessage} msg
     * @returns {void}
     * @private
     */
    _onAccountsRejected(msg) {
        Log.d(NanoConsensusAgent, `[ACCOUNTS-REJECTED] Received from ${this._peer.peerAddress}`);

        // Check if we have requested an accounts proof, reject unsolicited ones.
        if (!this._accountsRequest) {
            Log.w(NanoConsensusAgent, `Unsolicited accounts rejected received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getAccountsProof');
        const reject = this._accountsRequest.reject;

        // Reset accountsRequest.
        this._accountsRequest = null;


        reject(new Error('Accounts request was rejected'));
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<Array.<Transaction>>}
     */
    getTransactions(blockHash, addresses) {
        return this._synchronizer.push(() => {
            return this._getTransactions(blockHash, addresses);
        });
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @returns {Promise.<Array<Transaction>>}
     * @private
     */
    async _getTransactions(blockHash, addresses) {
        Assert.that(this._transactionsRequest === null);

        Log.d(NanoConsensusAgent, `Requesting TransactionsProof for ${addresses} from ${this._peer.peerAddress}`);

        /** @type {Block} */
        const block = await this._blockchain.getBlock(blockHash);
        if (!block) {
            Log.d(NanoConsensusAgent, `Requested block with hash ${blockHash} not found`);
            return [];
        }

        return new Promise((resolve, reject) => {
            this._transactionsRequest = {
                addresses: addresses,
                blockHash: blockHash,
                header: block.header,
                resolve: resolve,
                reject: reject
            };

            // Request AccountsProof from peer.
            this._peer.channel.getTransactionsProof(blockHash, addresses);

            // Drop the peer if it doesn't send the accounts proof within the timeout.
            this._timers.setTimeout('getTransactionsProof', () => {
                this._peer.channel.close('getTransactionsProof timeout');
                reject(new Error('timeout')); // TODO error handling
            }, NanoConsensusAgent.TRANSACTIONSPROOF_REQUEST_TIMEOUT);
        });
    }

    /**
     * @param {TransactionsProofMessage} msg
     * @returns {Promise.<void>}
     * @private
     */
    async _onTransactionsProof(msg) {
        Log.d(NanoConsensusAgent, `[TRANSACTIONS-PROOF] Received from ${this._peer.peerAddress}: blockHash=${msg.blockHash}, transactions=${msg.transactions}, proof=${msg.proof} (${msg.serializedSize} bytes)`);

        // Check if we have requested a transactions proof, reject unsolicited ones.
        if (!this._transactionsRequest) {
            Log.w(NanoConsensusAgent, `Unsolicited transactions proof received from ${this._peer.peerAddress}`);
            // TODO close/ban?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getTransactionsProof');

        const blockHash = this._transactionsRequest.blockHash;
        /** @type {BlockHeader} */
        const header = this._transactionsRequest.header;
        const resolve = this._transactionsRequest.resolve;
        const reject = this._transactionsRequest.reject;

        // Reset transactionsRequest.
        this._transactionsRequest = null;

        // Check that the reference block corresponds to the one we requested.
        if (!blockHash.equals(msg.blockHash)) {
            Log.w(NanoConsensusAgent, `Received TransactionsProof for invalid reference block from ${this._peer.peerAddress}`);
            reject(new Error('Invalid reference block'));
            return;
        }

        // Verify the proof.
        const proof = msg.proof;
        if (!header.bodyHash.equals(await proof.root())) {
            Log.w(NanoConsensusAgent, `Invalid TransactionsProof received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('Invalid TransactionsProof');
            reject(new Error('Invalid TransactionsProof'));
            return;
        }

        // Return the retrieved transactions.
        resolve(proof.transactions);
    }

    /**
     * @param {Hash} hash
     * @returns {Promise.<Block>}
     */
    getFullBlock(hash) {
        // TODO we can use a different synchronizer here, no need to synchronize with getAccounts().
        return this._synchronizer.push(() => {
            return this._getFullBlock(hash);
        });
    }

    /**
     * @param {Hash} hash
     * @returns {Promise.<Block>}
     * @private
     */
    _getFullBlock(hash) {
        Assert.that(this._blockRequest === null);

        Log.d(NanoConsensusAgent, `Requesting full block ${hash} from ${this._peer.peerAddress}`);

        return new Promise((resolve, reject) => {
            this._blockRequest = {
                hash: hash,
                resolve: resolve,
                reject: reject
            };

            // Request full block from peer.
            const vector = new InvVector(InvVector.Type.BLOCK, hash);
            this._peer.channel.getData([vector]);

            // Drop the peer if it doesn't send the block within the timeout.
            this._timers.setTimeout('getBlock', () => {
                this._peer.channel.close('getBlock timeout');
                reject(new Error('timeout')); // TODO error handling
            }, BaseConsensusAgent.REQUEST_TIMEOUT);
        });
    }

    /**
     * @param {BlockMessage} msg
     * @return {Promise.<void>}
     * @protected
     * @override
     */
    async _onBlock(msg) {
        // Ignore all block messages that we didn't request.
        if (!this._blockRequest) {
            Log.w(NanoConsensusAgent, `Unsolicited block message received from ${this._peer.peerAddress}, discarding`);
            // TODO close/ban?
            return;
        }

        // Clear the request timeout.
        this._timers.clearTimeout('getBlock');

        const blockHash = this._blockRequest.hash;
        const resolve = this._blockRequest.resolve;
        const reject = this._blockRequest.reject;

        // Reset blockRequest.
        this._blockRequest = null;

        // Check if we asked for this specific block.
        const hash = await msg.block.hash();
        if (!hash.equals(blockHash)) {
            Log.w(NanoConsensusAgent, `Unexpected block received from ${this._peer.peerAddress}, discarding`);
            // TODO close/ban?
            reject(new Error('Unexpected block'));
            return;
        }

        // Verify block.
        // TODO should we let the caller do that instead?
        if (!(await msg.block.verify())) {
            Log.w(NanoConsensusAgent, `Invalid block received from ${this._peer.peerAddress}`);
            // TODO ban instead?
            this._peer.channel.close('Invalid block');
            reject(new Error('Invalid block'));
            return;
        }

        // Return the retrieved block.
        resolve(msg.block);
    }

    /**
     * @param {NotFoundMessage} msg
     * @returns {void}
     * @protected
     * @override
     */
    _onNotFound(msg) {
        // Check if this notfound message corresponds to our block request.
        if (this._blockRequest && msg.vectors.length === 1 && msg.vectors[0].hash.equals(this._blockRequest.hash)) {
            this._timers.clearTimeout('getBlock');

            const reject = this._blockRequest.reject;
            this._blockRequest = null;

            reject(new Error('Block not found'));
        }

        super._onNotFound(msg);
    }

    /**
     * @returns {void}
     * @protected
     * @override
     */
    _onClose() {
        // Clear the synchronizer queue.
        this._synchronizer.clear();
        super._onClose();
    }
}
/**
 * Maximum time (ms) to wait for chainProof after sending out getChainProof before dropping the peer.
 * @type {number}
 */
NanoConsensusAgent.CHAINPROOF_REQUEST_TIMEOUT = 1000 * 30;
/**
 * Maximum time (ms) to wait for accountsProof after sending out getAccountsProof before dropping the peer.
 * @type {number}
 */
NanoConsensusAgent.ACCOUNTSPROOF_REQUEST_TIMEOUT = 1000 * 5;
NanoConsensusAgent.TRANSACTIONSPROOF_REQUEST_TIMEOUT = 1000 * 10;
Class.register(NanoConsensusAgent);

class NanoConsensus extends Observable {
    /**
     * @param {NanoChain} blockchain
     * @param {NanoMempool} mempool
     * @param {Network} network
     */
    constructor(blockchain, mempool, network) {
        super();
        /** @type {NanoChain} */
        this._blockchain = blockchain;
        /** @type {NanoMempool} */
        this._mempool = mempool;
        /** @type {Network} */
        this._network = network;

        /** @type {HashMap.<Peer, NanoConsensusAgent>} */
        this._agents = new HashMap();

        /** @type {Timers} */
        this._timers = new Timers();

        /** @type {boolean} */
        this._established = false;

        /** @type {Peer} */
        this._syncPeer = null;

        network.on('peer-joined', peer => this._onPeerJoined(peer));
        network.on('peer-left', peer => this._onPeerLeft(peer));

        // Notify peers when our blockchain head changes.
        blockchain.on('head-changed', head => {
            // Don't announce head changes if we are not synced yet.
            if (!this._established) return;

            for (const agent of this._agents.values()) {
                agent.relayBlock(head);
            }
        });
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerJoined(peer) {
        // Create a ConsensusAgent for each peer that connects.
        const agent = new NanoConsensusAgent(this._blockchain, this._mempool, peer);
        this._agents.put(peer.id, agent);

        // Register agent event listeners.
        agent.on('close', () => this._onPeerLeft(agent.peer));
        agent.on('sync', () => this._onPeerSynced(agent.peer));

        this.bubble(agent, 'sync-chain-proof', 'verify-chain-proof');

        // If no more peers connect within the specified timeout, start syncing.
        this._timers.resetTimeout('sync', this._syncBlockchain.bind(this), NanoConsensus.SYNC_THROTTLE);
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerLeft(peer) {
        // Reset syncPeer if it left during the sync.
        if (peer.equals(this._syncPeer)) {
            Log.w(NanoConsensus, `Peer ${peer.peerAddress} left during sync`);
            this._syncPeer = null;
            this.fire('sync-failed', peer.peerAddress);
        }

        this._agents.remove(peer.id);
        this._syncBlockchain();
    }

    /**
     * @private
     */
    _syncBlockchain() {
        // Wait for ongoing sync to finish.
        if (this._syncPeer) {
            return;
        }

        // Choose a random peer which we aren't sync'd with yet.
        const agents = this._agents.values().filter(agent => !agent.synced);
        const agent = ArrayUtils.randomElement(agents);
        if (!agent) {
            // We are synced with all connected peers.
            if (this._agents.length > 0) {
                // Report consensus-established if we have at least one connected peer.
                // TODO !!! Check peer types (at least one full node, etc.) !!!
                if (!this._established) {
                    Log.i(NanoConsensus, `Synced with all connected peers (${this._agents.length}), consensus established.`);
                    Log.d(NanoConsensus, `Blockchain: height=${this._blockchain.height}, headHash=${this._blockchain.headHash}`);

                    this._established = true;
                    this.fire('established');
                }
            } else {
                // We are not connected to any peers anymore. Report consensus-lost.
                this._established = false;
                this.fire('lost');
            }

            return;
        }

        this._syncPeer = agent.peer;

        // Notify listeners when we start syncing and have not established consensus yet.
        if (!this._established) {
            this.fire('syncing', agent.peer.peerAddress, agents.length - 1);
        }

        Log.v(NanoConsensus, `Syncing blockchain with peer ${agent.peer.peerAddress}`);
        agent.syncBlockchain();
    }

    /**
     * @param {Peer} peer
     * @private
     */
    _onPeerSynced(peer) {
        // Reset syncPeer if we finished syncing with it.
        if (peer.equals(this._syncPeer)) {
            Log.v(NanoConsensus, `Finished sync with peer ${peer.peerAddress}`);
            this._syncPeer = null;
            this.fire('sync-finished', peer.peerAddress);
        }
        this._syncBlockchain();
    }

    /**
     * @param {Address} address
     * @param {Hash} [blockHash]
     * @returns {Promise.<Account>}
     */
    async getAccount(address, blockHash=null) {
        return (await this.getAccounts([address], blockHash))[0];
    }

    /**
     * @param {Array.<Address>} addresses
     * @param {Hash} [blockHash]
     * @returns {Promise.<Array<Account>>}
     */
    async getAccounts(addresses, blockHash=null) {
        blockHash = blockHash ? blockHash : this._blockchain.headHash;
        const agents = this._agents.values().filter(agent =>
            agent.synced
            && agent.knowsBlock(blockHash)
            && !Services.isNanoNode(agent.peer.peerAddress.services)
        );

        for (const agent of agents) {
            try {
                return await agent.getAccounts(blockHash, addresses); // eslint-disable-line no-await-in-loop
            } catch (e) {
                Log.w(NanoConsensus, `Failed to retrieve accounts ${addresses} from ${agent.peer.peerAddress}: ${e}`);
                // Try the next peer.
            }
        }

        // No peer supplied the requested account, fail.
        throw new Error(`Failed to retrieve accounts ${addresses}`);
    }

    /**
     * @param {Array.<Address>} addresses
     * @param {Hash} [blockHash]
     * @returns {Promise.<Array<Transaction>>}
     */
    async getTransactions(addresses, blockHash=null) {
        blockHash = blockHash ? blockHash : this._blockchain.headHash;
        const agents = this._agents.values().filter(agent =>
            agent.synced
            && agent.knowsBlock(blockHash)
            && !Services.isNanoNode(agent.peer.peerAddress.services)
        );

        for (const agent of agents) {
            try {
                return await agent.getTransactions(blockHash, addresses); // eslint-disable-line no-await-in-loop
            } catch (e) {
                Log.w(NanoConsensus, `Failed to retrieve transactions for ${addresses} from ${agent.peer.peerAddress}: ${e}`);
                // Try the next peer.
            }
        }

        // No peer supplied the requested account, fail.
        throw new Error(`Failed to retrieve transactions for ${addresses}`);
    }

    /**
     * @param {Transaction} transaction
     * @returns {Promise.<boolean>}
     */
    async relayTransaction(transaction) {
        // Fail if we are not connected to at least one full/light node.
        if (!this._agents.values().some(agent => !Services.isNanoNode(agent.peer.peerAddress.services))) {
            throw new Error('Failed to relay transaction - only nano nodes connected');
        }

        // Store transaction in mempool.
        if (!(await this._mempool.pushTransaction(transaction))) {
            throw new Error('Failed to relay transaction - mempool rejected transaction');
        }

        // Relay transaction to all connected peers.
        const promises = [];
        for (const agent of this._agents.values()) {
            promises.push(agent.relayTransaction(transaction));
        }

        // Fail if the transaction was not relayed.
        return Promise.all(promises).then(results => {
            if (!results.some(it => !!it)) {
                throw new Error('Failed to relay transaction - no agent relayed transaction');
            }
        });
    }

    /**
     * @param {Hash} hash
     * @returns {Promise.<Block>}
     */
    async getFullBlock(hash) {
        const agents = this._agents.values().filter(agent =>
            agent.synced
            && !Services.isNanoNode(agent.peer.peerAddress.services)
        );

        for (const agent of agents) {
            try {
                return await agent.getFullBlock(hash); // eslint-disable-line no-await-in-loop
            } catch (e) {
                Log.w(NanoConsensus, `Failed to retrieve full block ${hash} from ${agent.peer.peerAddress}: ${e}`);
                // Try the next peer.
            }
        }

        // No peer supplied the requested block, fail.
        throw new Error(`Failed to retrieve block ${hash}`);
    }

    /** @type {boolean} */
    get established() {
        return this._established;
    }

    // TODO confidence level?

    /** @type {IBlockchain} */
    get blockchain() {
        return this._blockchain;
    }

    /** @type {NanoMempool} */
    get mempool() {
        return this._mempool;
    }

    /** @type {Network} */
    get network() {
        return this._network;
    }
}
NanoConsensus.SYNC_THROTTLE = 1000; // ms
Class.register(NanoConsensus);

class NanoMempool extends Observable {
    constructor() {
        super();

        // Our pool of transactions.
        /** @type {HashMap.<Hash, Transaction>} */
        this._transactions = new HashMap();
    }

    /**
     * @param {Transaction} transaction
     * @fires Mempool#transaction-added
     * @returns {Promise.<boolean>}
     */
    async pushTransaction(transaction) {
        // Check if we already know this transaction.
        const hash = await transaction.hash();
        if (this._transactions.contains(hash)) {
            Log.v(Mempool, () => `Ignoring known transaction ${hash.toBase64()}`);
            return false;
        }

        // Verify transaction.
        if (!(await transaction.verify())) {
            return false;
        }

        // Evict the oldest transactions from the mempool if it grows too large.
        if (this._transactions.length >= NanoMempool.TRANSACTIONS_MAX_COUNT) {
            this._evictTransactions();
        }

        // Transaction is valid, add it to the mempool.
        this._transactions.put(hash, transaction);

        // Tell listeners about the new transaction we received.
        this.fire('transaction-added', transaction);

        return true;
    }

    /**
     * @param {Hash} hash
     * @returns {Transaction}
     */
    getTransaction(hash) {
        return this._transactions.get(hash);
    }

    /**
     * @param {number} maxCount
     * @returns {Array.<Transaction>}
     */
    getTransactions(maxCount = 5000) {
        // TODO Add logic here to pick the "best" transactions.
        const transactions = [];
        for (const transaction of this._transactions.values()) {
            if (transactions.length >= maxCount) break;
            transactions.push(transaction);
        }
        return transactions;
    }

    /**
     * @private
     */
    _evictTransactions() {
        const keyIterator = this._transactions.keyIterator();
        let {value:hash, done} = keyIterator.next();
        for (let i = 0; !done && i < NanoMempool.TRANSACTIONS_EVICT_COUNT; i++) {
            /** @type {Transaction} */
            this._transactions.remove(hash);

            ({value:hash, done} = keyIterator.next());
        }
    }
}
NanoMempool.TRANSACTIONS_MAX_COUNT = 50000;
NanoMempool.TRANSACTIONS_EVICT_COUNT = 5000;
Class.register(NanoMempool);

class ConsensusDB extends JDB.JungleDB {
    /**
     * @returns {Promise.<ConsensusDB>}
     */
    static async getFull() {
        if (!ConsensusDB._instance) {
            ConsensusDB._instance = await new ConsensusDB('full-consensus');
        }
        return ConsensusDB._instance;
    }

    /**
     * @returns {Promise.<ConsensusDB>}
     */
    static async getLight() {
        if (!ConsensusDB._instance) {
            ConsensusDB._instance = await new ConsensusDB('light-consensus');
        }
        return ConsensusDB._instance;
    }

    /**
     * @param {string} dbName
     * @returns {Promise.<ConsensusDB>}
     */
    constructor(dbName) {
        super(dbName, ConsensusDB.VERSION);
        return this._init();
    }

    /**
     * @returns {Promise.<ConsensusDB>}
     * @private
     */
    async _init() {
        // Initialize object stores.
        AccountsTreeStore.initPersistent(this);
        ChainDataStore.initPersistent(this);

        // Establish connection to database.
        await this.connect();

        return this;
    }
}
ConsensusDB._instance = null;
ConsensusDB.VERSION = 3;
Class.register(ConsensusDB);

class Consensus {
    /**
     * @return {Promise.<FullConsensus>}
     */
    static async full() {
        Services.configureServices(Services.FULL);
        Services.configureServiceMask(Services.FULL);
        await Crypto.prepareSyncCryptoWorker();

        /** @type {ConsensusDB} */
        const db = await ConsensusDB.getFull();
        /** @type {Accounts} */
        const accounts = await Accounts.getPersistent(db);
        /** @type {FullChain} */
        const blockchain = await FullChain.getPersistent(db, accounts);
        /** @type {Mempool} */
        const mempool = new Mempool(blockchain, accounts);
        /** @type {Network} */
        const network = await new Network(blockchain);

        return new FullConsensus(blockchain, mempool, network);
    }

    /**
     * @return {Promise.<LightConsensus>}
     */
    static async light() {
        Services.configureServices(Services.LIGHT);
        Services.configureServiceMask(Services.LIGHT | Services.FULL);
        await Crypto.prepareSyncCryptoWorker();

        /** @type {ConsensusDB} */
        const db = await ConsensusDB.getLight();
        /** @type {Accounts} */
        const accounts = await Accounts.getPersistent(db);
        /** @type {LightChain} */
        const blockchain = await LightChain.getPersistent(db, accounts);
        /** @type {Mempool} */
        const mempool = new Mempool(blockchain, accounts);
        /** @type {Network} */
        const network = await new Network(blockchain);

        return new LightConsensus(blockchain, mempool, network);
    }

    /**
     * @return {Promise.<NanoConsensus>}
     */
    static async nano() {
        Services.configureServices(Services.NANO);
        Services.configureServiceMask(Services.NANO | Services.LIGHT | Services.FULL);
        await Crypto.prepareSyncCryptoWorker();

        /** @type {NanoChain} */
        const blockchain = await new NanoChain();
        /** @type {NanoMempool} */
        const mempool = new NanoMempool();
        /** @type {Network} */
        const network = await new Network(blockchain);

        return new NanoConsensus(blockchain, mempool, network);
    }
}
Class.register(Consensus);

class Protocol {
}
Protocol.DUMB = 0;
Protocol.WS = 1;
Protocol.RTC = 2;
Class.register(Protocol);

class NetAddress {
    /**
     * @param {string} ip
     * @return {NetAddress}
     */
    static fromIP(ip) {
        const saneIp = NetUtils.sanitizeIP(ip);
        return new NetAddress(saneIp);
    }

    /**
     * @param {string} ip
     */
    constructor(ip) {
        /** @type {string} */
        this._ip = ip;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {NetAddress}
     */
    static unserialize(buf) {
        const ip = buf.readVarLengthString();

        // Allow empty NetAddresses.
        if (!ip) {
            return NetAddress.UNSPECIFIED;
        }

        return NetAddress.fromIP(ip);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeVarLengthString(this._ip);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*extraByte VarLengthString ip*/ 1
            + /*ip*/ this._ip.length;
    }

    /**
     * @param {NetAddress} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof NetAddress
            && this._ip === o.ip;
    }

    hashCode() {
        return this.toString();
    }

    /**
     * @return {string}
     */
    toString() {
        return `${this._ip}`;
    }

    /** @type {string} */
    get ip() {
        return this._ip;
    }

    /**
     * @return {boolean}
     */
    isPseudo() {
        return !this._ip || NetAddress.UNKNOWN.equals(this);
    }

    /**
     * @return {boolean}
     */
    isPrivate() {
        return this.isPseudo() || NetUtils.isPrivateIP(this._ip);
    }
}
NetAddress.UNSPECIFIED = new NetAddress('');
NetAddress.UNKNOWN = new NetAddress('<unknown>');
Class.register(NetAddress);

class PeerAddress {
    /**
     * @param {number} protocol
     * @param {number} services
     * @param {number} timestamp
     * @param {NetAddress} netAddress
     */
    constructor(protocol, services, timestamp, netAddress) {
        this._protocol = protocol;
        this._services = services;
        this._timestamp = timestamp;
        this._netAddress = netAddress || NetAddress.UNSPECIFIED;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {PeerAddress}
     */
    static unserialize(buf) {
        const protocol = buf.readUint8();
        switch (protocol) {
            case Protocol.WS:
                return WsPeerAddress.unserialize(buf);

            case Protocol.RTC:
                return RtcPeerAddress.unserialize(buf);

            case Protocol.DUMB:
                return DumbPeerAddress.unserialize(buf);

            default:
                throw `Malformed PeerAddress protocol ${protocol}`;
        }
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint8(this._protocol);
        buf.writeUint32(this._services);
        buf.writeUint64(this._timestamp);

        // Never serialize private netAddresses.
        if (this._netAddress.isPrivate()) {
            NetAddress.UNSPECIFIED.serialize(buf);
        } else {
            this._netAddress.serialize(buf);
        }

        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*protocol*/ 1
            + /*services*/ 4
            + /*timestamp*/ 8
            + this._netAddress.serializedSize;
    }

    /**
     * @param {PeerAddress|*} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof PeerAddress
            && this._protocol === o.protocol;
            /* services is ignored */
            /* timestamp is ignored */
            /* netAddress is ignored */
    }

    /** @type {number} */
    get protocol() {
        return this._protocol;
    }

    /** @type {number} */
    get services() {
        return this._services;
    }

    /** @type {number} */
    get timestamp() {
        return this._timestamp;
    }

    /** @type {number} */
    set timestamp(value) {
        // Never change the timestamp of a seed address.
        if (this.isSeed()) {
            return;
        }
        this._timestamp = value;
    }

    /** @type {NetAddress} */
    get netAddress() {
        return this._netAddress.isPseudo() ? null : this._netAddress;
    }

    /** @type {NetAddress} */
    set netAddress(value) {
        this._netAddress = value || NetAddress.UNSPECIFIED;
    }

    /**
     * @returns {boolean}
     */
    isSeed() {
        return this._timestamp === 0;
    }
}
Class.register(PeerAddress);

class WsPeerAddress extends PeerAddress {
    /**
     * @param {string} host
     * @param {number} port
     * @returns {WsPeerAddress}
     */
    static seed(host, port) {
        return new WsPeerAddress(Services.FULL, /*timestamp*/ 0, NetAddress.UNSPECIFIED, host, port);
    }

    /**
     * @param {number} services
     * @param {number} timestamp
     * @param {NetAddress} netAddress
     * @param {string} host
     * @param {number} port
     */
    constructor(services, timestamp, netAddress, host, port) {
        super(Protocol.WS, services, timestamp, netAddress);
        if (!host) throw 'Malformed host';
        if (!NumberUtils.isUint16(port)) throw 'Malformed port';
        this._host = host;
        this._port = port;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {WsPeerAddress}
     */
    static unserialize(buf) {
        const services = buf.readUint32();
        const timestamp = buf.readUint64();
        const netAddress = NetAddress.unserialize(buf);
        const host = buf.readVarLengthString();
        const port = buf.readUint16();
        return new WsPeerAddress(services, timestamp, netAddress, host, port);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeVarLengthString(this._host);
        buf.writeUint16(this._port);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*extra byte VarLengthString host*/ 1
            + this._host.length
            + /*port*/ 2;
    }

    /**
     * @override
     * @param {PeerAddress|*} o
     * @returns {boolean}
     */
    equals(o) {
        return super.equals(o)
            && o instanceof WsPeerAddress
            && this._host === o.host
            && this._port === o.port;
    }

    hashCode() {
        return this.toString();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `wss://${this._host}:${this._port}`;
    }

    /** @type {string} */
    get host() {
        return this._host;
    }

    /** @type {number} */
    get port() {
        return this._port;
    }
}
Class.register(WsPeerAddress);

class RtcPeerAddress extends PeerAddress {
    /**
     * @param {number} services
     * @param {number} timestamp
     * @param {NetAddress} netAddress
     * @param {SignalId} signalId
     * @param {number} distance
     */
    constructor(services, timestamp, netAddress, signalId, distance) {
        super(Protocol.RTC, services, timestamp, netAddress);
        if (!(signalId instanceof SignalId)) throw 'Malformed signalId';
        if (!NumberUtils.isUint8(distance)) throw 'Malformed distance';
        this._signalId = signalId;
        this._distance = distance;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {RtcPeerAddress}
     */
    static unserialize(buf) {
        const services = buf.readUint32();
        const timestamp = buf.readUint64();
        const netAddress = NetAddress.unserialize(buf);
        const signalId = SignalId.unserialize(buf);
        const distance = buf.readUint8();
        return new RtcPeerAddress(services, timestamp, netAddress, signalId, distance);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._signalId.serialize(buf);
        buf.writeUint8(this._distance);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*signalId*/ this._signalId.serializedSize
            + /*distance*/ 1;
    }

    /**
     * @override
     * @param {PeerAddress|*} o
     * @returns {boolean}
     */
    equals(o) {
        return super.equals(o)
            && o instanceof RtcPeerAddress
            && this._signalId.equals(o.signalId);
    }

    hashCode() {
        return this.toString();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `rtc://${this._signalId}`;
    }

    /** @type {SignalId} */
    get signalId() {
        return this._signalId;
    }

    /** @type {number} */
    get distance() {
        return this._distance;
    }

    // Changed when passed on to other peers.
    /** @type {number} */
    set distance(value) {
        this._distance = value;
    }
}
Class.register(RtcPeerAddress);

class DumbPeerAddress extends PeerAddress {
    /**
     * @param {number} services
     * @param {number} timestamp
     * @param {NetAddress} netAddress
     * @param {number} id
     */
    constructor(services, timestamp, netAddress, id) {
        super(Protocol.DUMB, services, timestamp, netAddress);
        this._id = id;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {DumbPeerAddress}
     */
    static unserialize(buf) {
        const services = buf.readUint32();
        const timestamp = buf.readUint64();
        const netAddress = NetAddress.unserialize(buf);
        const id = buf.readUint64();
        return new DumbPeerAddress(services, timestamp, netAddress, id);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint64(this._id);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*id*/ 8;
    }

    /**
     * @override
     * @param {PeerAddress} o
     * @returns {boolean}
     */
    equals(o) {
        return super.equals(o)
            && o instanceof DumbPeerAddress
            && this._id === o.id;
    }

    hashCode() {
        return this.toString();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `dumb://${this._id}`;
    }

    /** @type {number} */
    get id() {
        return this._id;
    }
}
Class.register(DumbPeerAddress);

// TODO Limit the number of addresses we store.
class PeerAddresses extends Observable {
    constructor() {
        super();

        /**
         * Set of PeerAddressStates of all peerAddresses we know.
         * @type {HashSet.<PeerAddressState>}
         * @private
         */
        this._store = new HashSet();

        /**
         * Map from signalIds to RTC peerAddresses.
         * @type {HashMap.<SignalId,PeerAddressState>}
         * @private
         */
        this._signalIds = new HashMap();

        // Number of WebSocket/WebRTC peers.
        /** @type {number} */
        this._peerCountWs = 0;
        /** @type {number} */
        this._peerCountRtc = 0;
        /** @type {number} */
        this._peerCountDumb = 0;

        /**
         * Number of ongoing outbound connection attempts.
         * @type {number}
         * @private
         */
        this._connectingCount = 0;

        // Init seed peers.
        this.add(/*channel*/ null, PeerAddresses.SEED_PEERS);

        // Setup housekeeping interval.
        setInterval(() => this._housekeeping(), PeerAddresses.HOUSEKEEPING_INTERVAL);
    }

    /**
     * @returns {?PeerAddress}
     */
    pickAddress() {
        const addresses = this._store.values();
        const numAddresses = addresses.length;

        // Pick a random start index.
        const index = Math.floor(Math.random() * numAddresses);

        // Score up to 1000 addresses starting from the start index and pick the
        // one with the highest score. Never pick addresses with score < 0.
        const minCandidates = Math.min(numAddresses, 1000);
        const candidates = new HashMap();
        for (let i = 0; i < numAddresses; i++) {
            const idx = (index + i) % numAddresses;
            const address = addresses[idx];
            const score = this._scoreAddress(address);
            if (score >= 0) {
                candidates.put(score, address);
                if (candidates.length >= minCandidates) {
                    break;
                }
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // Return the candidate with the highest score.
        const scores = candidates.keys().sort((a, b) => b - a);
        const winner = candidates.get(scores[0]);
        return winner.peerAddress;
    }

    /**
     * @param {PeerAddressState} peerAddressState
     * @returns {number}
     * @private
     */
    _scoreAddress(peerAddressState) {
        const peerAddress = peerAddressState.peerAddress;

        // Filter addresses that we cannot connect to.
        if (!NetworkConfig.canConnect(peerAddress.protocol)) {
            return -1;
        }

        // Filter addresses that are too old.
        if (this._exceedsAge(peerAddress)) {
            return -1;
        }

        const score = this._scoreProtocol(peerAddress)
            * ((peerAddress.timestamp / 1000) + 1);

        switch (peerAddressState.state) {
            case PeerAddressState.CONNECTING:
            case PeerAddressState.CONNECTED:
            case PeerAddressState.BANNED:
                return -1;

            case PeerAddressState.NEW:
            case PeerAddressState.TRIED:
                return score;

            case PeerAddressState.FAILED:
                return (1 - (peerAddressState.failedAttempts / peerAddressState.maxFailedAttempts)) * score;

            default:
                return -1;
        }
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {number}
     * @private
     */
    _scoreProtocol(peerAddress) {
        let score = 1;

        // We want at least two websocket connection
        if (this._peerCountWs < 2) {
            score *= peerAddress.protocol === Protocol.WS ? 3 : 1;
        } else {
            score *= peerAddress.protocol === Protocol.RTC ? 3 : 1;
        }

        // Prefer WebRTC addresses with lower distance:
        //  distance = 0: self
        //  distance = 1: direct connection
        //  distance = 2: 1 hop
        //  ...
        // We only expect distance >= 2 here.
        if (peerAddress.protocol === Protocol.RTC) {
            score *= 1 + ((PeerAddresses.MAX_DISTANCE - peerAddress.distance) / 2);
        }

        return score;
    }

    /** @type {number} */
    get peerCount() {
        return this._peerCountWs + this._peerCountRtc + this._peerCountDumb;
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {PeerAddress|null}
     */
    get(peerAddress) {
        /** @type {PeerAddressState} */
        const peerAddressState = this._store.get(peerAddress);
        return peerAddressState ? peerAddressState.peerAddress : null;
    }

    /**
     * @param {SignalId} signalId
     * @returns {PeerAddress|null}
     */
    getBySignalId(signalId) {
        /** @type {PeerAddressState} */
        const peerAddressState = this._signalIds.get(signalId);
        return peerAddressState ? peerAddressState.peerAddress : null;
    }

    /**
     * @param {SignalId} signalId
     * @returns {PeerChannel}
     */
    getChannelBySignalId(signalId) {
        const peerAddressState = this._signalIds.get(signalId);
        if (peerAddressState && peerAddressState.bestRoute) {
            return peerAddressState.bestRoute.signalChannel;
        }
        return null;
    }

    /**
     * @todo improve this by returning the best addresses first.
     * @param {number} protocolMask
     * @param {number} serviceMask
     * @param {number} maxAddresses
     * @returns {Array.<PeerAddress>}
     */
    query(protocolMask, serviceMask, maxAddresses = 1000) {
        // XXX inefficient linear scan
        const now = Date.now();
        const addresses = [];
        for (const peerAddressState of this._store.values()) {
            // Never return banned or failed addresses.
            if (peerAddressState.state === PeerAddressState.BANNED
                    || peerAddressState.state === PeerAddressState.FAILED) {
                continue;
            }

            // Never return seed peers.
            const address = peerAddressState.peerAddress;
            if (address.isSeed()) {
                continue;
            }

            // Only return addresses matching the protocol mask.
            if ((address.protocol & protocolMask) === 0) {
                continue;
            }

            // Only return addresses matching the service mask.
            if ((address.services & serviceMask) === 0) {
                continue;
            }

            // Update timestamp for connected peers.
            if (peerAddressState.state === PeerAddressState.CONNECTED) {
                address.timestamp = now;
                // Also update timestamp for RTC connections
                if (peerAddressState.bestRoute) {
                    peerAddressState.bestRoute.timestamp = now;
                }
            }

            // Never return addresses that are too old.
            if (this._exceedsAge(address)) {
                continue;
            }

            // Return this address.
            addresses.push(address);

            // Stop if we have collected maxAddresses.
            if (addresses.length >= maxAddresses) {
                break;
            }
        }
        return addresses;
    }

    /**
     * @param {PeerChannel} channel
     * @param {PeerAddress|Array.<PeerAddress>} arg
     */
    add(channel, arg) {
        const peerAddresses = Array.isArray(arg) ? arg : [arg];
        const newAddresses = [];

        for (const addr of peerAddresses) {
            if (this._add(channel, addr)) {
                newAddresses.push(addr);
            }
        }

        // Tell listeners that we learned new addresses.
        if (newAddresses.length) {
            this.fire('added', newAddresses, this);
        }
    }

    /**
     * @param {PeerChannel} channel
     * @param {PeerAddress|RtcPeerAddress} peerAddress
     * @returns {boolean}
     * @private
     */
    _add(channel, peerAddress) {
        // Ignore our own address.
        if (NetworkConfig.myPeerAddress().equals(peerAddress)) {
            return false;
        }

        // Ignore address if it is too old.
        // Special case: allow seed addresses (timestamp == 0) via null channel.
        if (channel && this._exceedsAge(peerAddress)) {
            Log.d(PeerAddresses, `Ignoring address ${peerAddress} - too old (${new Date(peerAddress.timestamp)})`);
            return false;
        }

        // Ignore address if its timestamp is too far in the future.
        if (peerAddress.timestamp > Date.now() + PeerAddresses.MAX_TIMESTAMP_DRIFT) {
            Log.d(PeerAddresses, `Ignoring addresses ${peerAddress} - timestamp in the future`);
            return false;
        }

        // Increment distance values of RTC addresses.
        if (peerAddress.protocol === Protocol.RTC) {
            peerAddress.distance++;

            // Ignore address if it exceeds max distance.
            if (peerAddress.distance > PeerAddresses.MAX_DISTANCE) {
                Log.d(PeerAddresses, `Ignoring address ${peerAddress} - max distance exceeded`);
                // Drop any route to this peer over the current channel. This may prevent loops.
                const peerAddressState = this._store.get(peerAddress);
                if (peerAddressState) {
                    peerAddressState.deleteRoute(channel);
                }
                return false;
            }
        }

        // Check if we already know this address.
        let peerAddressState = this._store.get(peerAddress);
        if (peerAddressState) {
            const knownAddress = peerAddressState.peerAddress;

            // Ignore address if it is banned.
            if (peerAddressState.state === PeerAddressState.BANNED) {
                return false;
            }

            // Never update the timestamp of seed peers.
            if (knownAddress.isSeed()) {
                peerAddress.timestamp = 0;
            }

            // Never erase NetAddresses.
            if (knownAddress.netAddress && !peerAddress.netAddress) {
                peerAddress.netAddress = knownAddress.netAddress;
            }

            // Ignore address if it is a websocket address and we already know this address with a more recent timestamp.
            if (peerAddress.protocol === Protocol.WS && knownAddress.timestamp >= peerAddress.timestamp) {
                return false;
            }
        } else {
            // Add new peerAddressState.
            peerAddressState = new PeerAddressState(peerAddress);
            this._store.add(peerAddressState);
            if (peerAddress.protocol === Protocol.RTC) {
                // Index by signalId.
                this._signalIds.put(peerAddress.signalId, peerAddressState);
            }
        }

        // Add route.
        if (peerAddress.protocol === Protocol.RTC) {
            peerAddressState.addRoute(channel, peerAddress.distance, peerAddress.timestamp);
        }

        // If we are currently connected, allow only updates to the netAddress and only if we don't know it yet.
        if (peerAddressState.state === PeerAddressState.CONNECTED) {
            if (!peerAddressState.peerAddress.netAddress && peerAddress.netAddress) {
                peerAddressState.peerAddress.netAddress = peerAddress.netAddress;
            }

            return false;
        }

        // Update the address.
        peerAddressState.peerAddress = peerAddress;

        return true;
    }

    /**
     * Called when a connection to this peerAddress is being established.
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    connecting(peerAddress) {
        const peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            return;
        }
        if (peerAddressState.state === PeerAddressState.BANNED) {
            throw 'Connecting to banned address';
        }
        if (peerAddressState.state === PeerAddressState.CONNECTED) {
            throw `Duplicate connection to ${peerAddress}`;
        }

        if (peerAddressState.state !== PeerAddressState.CONNECTING) {
            this._connectingCount++;
        }
        peerAddressState.state = PeerAddressState.CONNECTING;
    }

    /**
     * Called when a connection to this peerAddress has been established.
     * The connection might have been initiated by the other peer, so address
     * may not be known previously.
     * If it is already known, it has been updated by a previous version message.
     * @param {PeerChannel} channel
     * @param {PeerAddress|RtcPeerAddress} peerAddress
     * @returns {void}
     */
    connected(channel, peerAddress) {
        let peerAddressState = this._store.get(peerAddress);
        
        if (!peerAddressState) {
            peerAddressState = new PeerAddressState(peerAddress);

            if (peerAddress.protocol === Protocol.RTC) {
                this._signalIds.put(peerAddress.signalId, peerAddressState);
            }

            this._store.add(peerAddressState);
        } else {
            // Never update the timestamp of seed peers.
            if (peerAddressState.peerAddress.isSeed()) {
                peerAddress.timestamp = 0;
            }
        }

        if (peerAddressState.state === PeerAddressState.BANNED
            // Allow recovering seed peer's inbound connection to succeed.
            && !peerAddressState.peerAddress.isSeed()) {

            throw 'Connected to banned address';
        }

        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._connectingCount--;
        }
        if (peerAddressState.state !== PeerAddressState.CONNECTED) {
            this._updateConnectedPeerCount(peerAddress, 1);
        }

        peerAddressState.state = PeerAddressState.CONNECTED;
        peerAddressState.lastConnected = Date.now();
        peerAddressState.failedAttempts = 0;
        peerAddressState.banBackoff = PeerAddresses.INITIAL_FAILED_BACKOFF;

        peerAddressState.peerAddress = peerAddress;
        peerAddressState.peerAddress.timestamp = Date.now();

        // Add route.
        if (peerAddress.protocol === Protocol.RTC) {
            peerAddressState.addRoute(channel, peerAddress.distance, peerAddress.timestamp);
        }
    }

    /**
     * Called when a connection to this peerAddress is closed.
     * @param {PeerChannel} channel
     * @param {PeerAddress} peerAddress
     * @param {boolean} closedByRemote
     * @returns {void}
     */
    disconnected(channel, peerAddress, closedByRemote) {
        const peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            return;
        }

        // Delete all addresses that were signalable over the disconnected peer.
        if (channel) {
            this._removeBySignalChannel(channel);
        }

        if (peerAddressState.state === PeerAddressState.BANNED) {
            return;
        }
        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._connectingCount--;
        }
        if (peerAddressState.state === PeerAddressState.CONNECTED) {
            this._updateConnectedPeerCount(peerAddress, -1);
        }

        // Always set state to tried, even when deciding to delete this address.
        // In the latter case, this will not influence the deletion,
        // but it will prevent decrementing the peer count twice when banning seed nodes.
        peerAddressState.state = PeerAddressState.TRIED;

        // XXX Immediately delete address if the remote host closed the connection.
        // Also immediately delete dumb clients, since we cannot connect to those anyway.
        if ((closedByRemote && PlatformUtils.isOnline()) || peerAddress.protocol === Protocol.DUMB) {
            this._remove(peerAddress);
        }
    }

    /**
     * Called when a network connection to this peerAddress has failed.
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    failure(peerAddress) {
        const peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            return;
        }
        if (peerAddressState.state === PeerAddressState.BANNED) {
            return;
        }
        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._connectingCount--;
        }

        peerAddressState.state = PeerAddressState.FAILED;
        peerAddressState.failedAttempts++;

        if (peerAddressState.failedAttempts >= peerAddressState.maxFailedAttempts) {
            // Remove address only if we have tried the maximum number of backoffs.
            if (peerAddressState.banBackoff >= PeerAddresses.MAX_FAILED_BACKOFF) {
                this._remove(peerAddress);
            } else {
                this.ban(peerAddress, peerAddressState.banBackoff);
                peerAddressState.banBackoff = Math.min(PeerAddresses.MAX_FAILED_BACKOFF, peerAddressState.banBackoff * 2);
            }
        }
    }

    /**
     * Called when a message has been returned as unroutable.
     * @param {PeerChannel} channel
     * @param {PeerAddress} peerAddress
     * @returns {void}
     */
    unroutable(channel, peerAddress) {
        if (!peerAddress) {
            return;
        }

        const peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            return;
        }

        if (!peerAddressState.bestRoute || !peerAddressState.bestRoute.signalChannel.equals(channel)) {
            Log.w(PeerAddresses, `Got unroutable for ${peerAddress} on a channel other than the best route.`);
            return;
        }

        peerAddressState.deleteBestRoute();
        if (!peerAddressState.hasRoute()) {
            this._remove(peerAddressState.peerAddress);
        }
    }

    /**
     * @param {PeerAddress} peerAddress
     * @param {number} [duration] in milliseconds
     * @returns {void}
     */
    ban(peerAddress, duration = PeerAddresses.DEFAULT_BAN_TIME) {
        let peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            peerAddressState = new PeerAddressState(peerAddress);
            this._store.add(peerAddressState);
        }
        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._connectingCount--;
        }
        if (peerAddressState.state === PeerAddressState.CONNECTED) {
            this._updateConnectedPeerCount(peerAddress, -1);
        }

        peerAddressState.state = PeerAddressState.BANNED;
        peerAddressState.bannedUntil = Date.now() + duration;

        // Drop all routes to this peer.
        peerAddressState.deleteAllRoutes();
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {boolean}
     */
    isConnected(peerAddress) {
        const peerAddressState = this._store.get(peerAddress);
        return peerAddressState && peerAddressState.state === PeerAddressState.CONNECTED;
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {boolean}
     */
    isBanned(peerAddress) {
        const peerAddressState = this._store.get(peerAddress);
        return peerAddressState
            && peerAddressState.state === PeerAddressState.BANNED
            // XXX Never consider seed peers to be banned. This allows us to use
            // the banning mechanism to prevent seed peers from being picked when
            // they are down, but still allows recovering seed peers' inbound
            // connections to succeed.
            && !peerAddressState.peerAddress.isSeed();
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {void}
     * @private
     */
    _remove(peerAddress) {
        const peerAddressState = this._store.get(peerAddress);
        if (!peerAddressState) {
            return;
        }

        // Never delete seed addresses, ban them instead for a couple of minutes.
        if (peerAddressState.peerAddress.isSeed()) {
            this.ban(peerAddress, peerAddressState.banBackoff);
            return;
        }

        // Delete from signalId index.
        if (peerAddress.protocol === Protocol.RTC) {
            this._signalIds.remove(peerAddress.signalId);
        }

        if (peerAddressState.state === PeerAddressState.CONNECTING) {
            this._connectingCount--;
        }

        // Don't delete bans.
        if (peerAddressState.state === PeerAddressState.BANNED) {
            return;
        }

        // Delete the address.
        this._store.remove(peerAddress);
    }

    /**
     * Delete all RTC-only routes that are signalable over the given peer.
     * @param {PeerChannel} channel
     * @returns {void}
     * @private
     */
    _removeBySignalChannel(channel) {
        // XXX inefficient linear scan
        for (const peerAddressState of this._store.values()) {
            if (peerAddressState.peerAddress.protocol === Protocol.RTC) {
                peerAddressState.deleteRoute(channel);
                if (!peerAddressState.hasRoute()) {
                    this._remove(peerAddressState.peerAddress);
                }
            }
        }
    }

    /**
     * @param {PeerAddress} peerAddress
     * @param {number} delta
     * @returns {void}
     * @private
     */
    _updateConnectedPeerCount(peerAddress, delta) {
        switch (peerAddress.protocol) {
            case Protocol.WS:
                this._peerCountWs += delta;
                break;
            case Protocol.RTC:
                this._peerCountRtc += delta;
                break;
            case Protocol.DUMB:
                this._peerCountDumb += delta;
                break;
            default:
                Log.w(PeerAddresses, `Unknown protocol ${peerAddress.protocol}`);
        }
    }

    /**
     * @returns {void}
     * @private
     */
    _housekeeping() {
        const now = Date.now();
        const unbannedAddresses = [];

        for (/** @type {PeerAddressState} */ const peerAddressState of this._store.values()) {
            const addr = peerAddressState.peerAddress;

            switch (peerAddressState.state) {
                case PeerAddressState.NEW:
                case PeerAddressState.TRIED:
                case PeerAddressState.FAILED:
                    // Delete all new peer addresses that are older than MAX_AGE.
                    if (this._exceedsAge(addr)) {
                        Log.d(PeerAddresses, `Deleting old peer address ${addr}`);
                        this._remove(addr);
                    }
                    break;

                case PeerAddressState.BANNED:
                    if (peerAddressState.bannedUntil <= now) {
                        // If we banned because of failed attempts or it is a seed node, try again.
                        if (peerAddressState.failedAttempts >= peerAddressState.maxFailedAttempts || addr.isSeed()) {
                            // Restore banned seed addresses to the NEW state.
                            peerAddressState.state = PeerAddressState.NEW;
                            peerAddressState.failedAttempts = 0;
                            peerAddressState.bannedUntil = -1;
                            unbannedAddresses.push(addr);
                        } else {
                            // Delete expires bans.
                            this._store.remove(addr);
                        }
                    }
                    break;

                case PeerAddressState.CONNECTED:
                    // Keep timestamp up-to-date while we are connected.
                    addr.timestamp = now;
                    // Also update timestamp for RTC connections
                    if (peerAddressState.bestRoute) {
                        peerAddressState.bestRoute.timestamp = now;
                    }
                    break;

                default:
                    // TODO What about peers who are stuck connecting? Can this happen?
                    // Do nothing for CONNECTING peers.
            }
        }

        if (unbannedAddresses.length) {
            this.fire('added', unbannedAddresses, this);
        }
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {boolean}
     * @private
     */
    _exceedsAge(peerAddress) {
        // Seed addresses are never too old.
        if (peerAddress.isSeed()) {
            return false;
        }

        const age = Date.now() - peerAddress.timestamp;
        switch (peerAddress.protocol) {
            case Protocol.WS:
                return age > PeerAddresses.MAX_AGE_WEBSOCKET;

            case Protocol.RTC:
                return age > PeerAddresses.MAX_AGE_WEBRTC;

            case Protocol.DUMB:
                return age > PeerAddresses.MAX_AGE_DUMB;
        }
        return false;
    }

    /** @type {number} */
    get peerCountWs() {
        return this._peerCountWs;
    }

    /** @type {number} */
    get peerCountRtc() {
        return this._peerCountRtc;
    }

    /** @type {number} */
    get peerCountDumb() {
        return this._peerCountDumb;
    }

    /** @type {number} */
    get connectingCount() {
        return this._connectingCount;
    }
}
PeerAddresses.MAX_AGE_WEBSOCKET = 1000 * 60 * 30; // 30 minutes
PeerAddresses.MAX_AGE_WEBRTC = 1000 * 60 * 10; // 10 minutes
PeerAddresses.MAX_AGE_DUMB = 1000 * 60; // 1 minute
PeerAddresses.MAX_DISTANCE = 4;
PeerAddresses.MAX_FAILED_ATTEMPTS_WS = 3;
PeerAddresses.MAX_FAILED_ATTEMPTS_RTC = 2;
PeerAddresses.MAX_TIMESTAMP_DRIFT = 1000 * 60 * 10; // 10 minutes
PeerAddresses.HOUSEKEEPING_INTERVAL = 1000 * 60; // 1 minute
PeerAddresses.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PeerAddresses.INITIAL_FAILED_BACKOFF = 1000 * 15; // 15 seconds
PeerAddresses.MAX_FAILED_BACKOFF = 1000 * 60 * 10; // 10 minutes
PeerAddresses.SEED_PEERS = [
    WsPeerAddress.seed('alpacash.com', 8080),
    WsPeerAddress.seed('nimiq1.styp-rekowsky.de', 8080),
    WsPeerAddress.seed('nimiq2.styp-rekowsky.de', 8080),
    WsPeerAddress.seed('seed1.nimiq-network.com', 8080),
    WsPeerAddress.seed('seed2.nimiq-network.com', 8080),
    WsPeerAddress.seed('seed3.nimiq-network.com', 8080),
    WsPeerAddress.seed('seed4.nimiq-network.com', 8080),
    WsPeerAddress.seed('emily.nimiq-network.com', 443)
];
Class.register(PeerAddresses);

class PeerAddressState {
    /**
     * @param {PeerAddress} peerAddress
     */
    constructor(peerAddress) {
        /** @type {PeerAddress} */
        this.peerAddress = peerAddress;

        /** @type {number} */
        this.state = PeerAddressState.NEW;
        /** @type {number} */
        this.lastConnected = -1;
        /** @type {number} */
        this.bannedUntil = -1;
        /** @type {number} */
        this.banBackoff = PeerAddresses.INITIAL_FAILED_BACKOFF;

        /** @type {SignalRoute} */
        this._bestRoute = null;
        /** @type {HashSet.<SignalRoute>} */
        this._routes = new HashSet();

        /** @type {number} */
        this._failedAttempts = 0;
    }

    /** @type {number} */
    get maxFailedAttempts() {
        switch (this.peerAddress.protocol) {
            case Protocol.RTC:
                return PeerAddresses.MAX_FAILED_ATTEMPTS_RTC;
            case Protocol.WS:
                return PeerAddresses.MAX_FAILED_ATTEMPTS_WS;
            default:
                return 0;
        }
    }

    /** @type {number} */
    get failedAttempts() {
        if (this._bestRoute) {
            return this._bestRoute.failedAttempts;
        } else {
            return this._failedAttempts;
        }
    }

    /** @type {number} */
    set failedAttempts(value) {
        if (this._bestRoute) {
            this._bestRoute.failedAttempts = value;
            this._updateBestRoute(); // scores may have changed
        } else {
            this._failedAttempts = value;
        }
    }

    /** @type {SignalRoute} */
    get bestRoute() {
        return this._bestRoute;
    }

    /**
     * @param {PeerChannel} signalChannel
     * @param {number} distance
     * @param {number} timestamp
     * @returns {void}
     */
    addRoute(signalChannel, distance, timestamp) {
        const oldRoute = this._routes.get(signalChannel);
        const newRoute = new SignalRoute(signalChannel, distance, timestamp);

        if (oldRoute) {
            // Do not reset failed attempts.
            newRoute.failedAttempts = oldRoute.failedAttempts;
        }
        this._routes.add(newRoute);

        if (!this._bestRoute || newRoute.score > this._bestRoute.score
            || (newRoute.score === this._bestRoute.score && timestamp > this._bestRoute.timestamp)) {

            this._bestRoute = newRoute;
            this.peerAddress.distance = this._bestRoute.distance;
        }
    }

    /**
     * @returns {void}
     */
    deleteBestRoute() {
        if (this._bestRoute) {
            this.deleteRoute(this._bestRoute.signalChannel);
        }
    }

    /**
     * @param {PeerChannel} signalChannel
     * @returns {void}
     */
    deleteRoute(signalChannel) {
        this._routes.remove(signalChannel); // maps to same hashCode
        if (this._bestRoute && this._bestRoute.signalChannel.equals(signalChannel)) {
            this._updateBestRoute();
        }
    }

    /**
     * @returns {void}
     */
    deleteAllRoutes() {
        this._bestRoute = null;
        this._routes = new HashSet();
    }

    /**
     * @returns {boolean}
     */
    hasRoute() {
        return this._routes.length > 0;
    }

    /**
     * @returns {void}
     * @private
     */
    _updateBestRoute() {
        let bestRoute = null;
        // Choose the route with minimal distance and maximal timestamp.
        for (const route of this._routes.values()) {
            if (bestRoute === null || route.score > bestRoute.score
                || (route.score === bestRoute.score && route.timestamp > bestRoute.timestamp)) {

                bestRoute = route;
            }
        }
        this._bestRoute = bestRoute;
        if (this._bestRoute) {
            this.peerAddress.distance = this._bestRoute.distance;
        } else {
            this.peerAddress.distance = PeerAddresses.MAX_DISTANCE + 1;
        }
    }

    /**
     * @param {PeerAddressState|*} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof PeerAddressState
            && this.peerAddress.equals(o.peerAddress);
    }

    /**
     * @returns {string}
     */
    hashCode() {
        return this.peerAddress.hashCode();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `PeerAddressState{peerAddress=${this.peerAddress}, state=${this.state}, `
            + `lastConnected=${this.lastConnected}, failedAttempts=${this.failedAttempts}, `
            + `bannedUntil=${this.bannedUntil}}`;
    }
}
PeerAddressState.NEW = 1;
PeerAddressState.CONNECTING = 2;
PeerAddressState.CONNECTED = 3;
PeerAddressState.TRIED = 4;
PeerAddressState.FAILED = 5;
PeerAddressState.BANNED = 6;
Class.register(PeerAddressState);

class SignalRoute {
    /**
     * @param {PeerChannel} signalChannel
     * @param {number} distance
     * @param {number} timestamp
     */
    constructor(signalChannel, distance, timestamp) {
        this.failedAttempts = 0;
        this.timestamp = timestamp;
        this._signalChannel = signalChannel;
        this._distance = distance;
    }

    /** @type {PeerChannel} */
    get signalChannel() {
        return this._signalChannel;
    }

    /** @type {number} */
    get distance() {
        return this._distance;
    }

    /** @type {number} */
    get score() {
        return ((PeerAddresses.MAX_DISTANCE - this._distance) / 2) * (1 - (this.failedAttempts / PeerAddresses.MAX_FAILED_ATTEMPTS_RTC));
    }

    /**
     * @param {SignalRoute} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof SignalRoute
            && this._signalChannel.equals(o._signalChannel);
    }

    /**
     * @returns {string}
     */
    hashCode() {
        return this._signalChannel.hashCode();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `SignalRoute{signalChannel=${this._signalChannel}, distance=${this._distance}, timestamp=${this.timestamp}, failedAttempts=${this.failedAttempts}}`;
    }
}
Class.register(SignalRoute);

class SignalId extends Primitive {
    /**
     * @param {SignalId} o
     * @returns {SignalId}
     */
    static copy(o) {
        if (!o) return o;
        const obj = new Uint8Array(o._obj);
        return new SignalId(obj);
    }

    constructor(arg) {
        super(arg, Uint8Array, SignalId.SERIALIZED_SIZE);
    }

    /**
     * Create Address object from binary form.
     * @param {SerialBuffer} buf Buffer to read from.
     * @return {SignalId} Newly created Account object.
     */
    static unserialize(buf) {
        return new SignalId(buf.read(SignalId.SERIALIZED_SIZE));
    }

    /**
     * Serialize this Address object into binary form.
     * @param {?SerialBuffer} [buf] Buffer to write to.
     * @return {SerialBuffer} Buffer from `buf` or newly generated one.
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.write(this._obj);
        return buf;
    }

    subarray(begin, end) {
        return this._obj.subarray(begin, end);
    }

    /**
     * @type {number}
     */
    get serializedSize() {
        return SignalId.SERIALIZED_SIZE;
    }

    /**
     * @param {Primitive} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof SignalId
            && super.equals(o);
    }

    /**
     * @returns {string}
     * @override
     */
    toString() {
        return this.toHex();
    }

    /**
     * @param {string} base64
     * @return {SignalId}
     */
    static fromBase64(base64) {
        return new SignalId(BufferUtils.fromBase64(base64));
    }

    /**
     * @param {string} hex
     * @return {SignalId}
     */
    static fromHex(hex) {
        return new SignalId(BufferUtils.fromHex(hex));
    }
}

SignalId.SERIALIZED_SIZE = 16;
Class.register(SignalId);

class Message {
    /**
     * Create a new Message instance. This is usually not called directly but by subclasses.
     * @param {Message.Type} type Message type
     */
    constructor(type) {
        if (!NumberUtils.isUint64(type)) throw 'Malformed type';
        /** @type {Message.Type} */
        this._type = type;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {Message.Type}
     */
    static peekType(buf) {
        // Store current read position.
        const pos = buf.readPos;

        // Set read position past the magic to the beginning of the type string.
        buf.readPos = 4;

        // Read the type string.
        const type = buf.readVarUint();

        // Reset the read position to original.
        buf.readPos = pos;

        return type;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {Message}
     */
    static unserialize(buf) {
        // XXX Direct buffer manipulation currently requires this.
        Assert.that(buf.readPos === 0, 'Message.unserialize() requires buf.readPos == 0');

        const magic = buf.readUint32();
        const type = buf.readVarUint();
        buf.readUint32(); // length is ignored
        const checksum = buf.readUint32();

        // Validate magic.
        if (magic !== Message.MAGIC) throw 'Malformed magic';

        // Validate checksum.
        Message._writeChecksum(type, buf, 0);
        const calculatedChecksum = CRC32.compute(buf);
        if (checksum !== calculatedChecksum) throw new Error('Invalid checksum');

        return new Message(type);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        // XXX Direct buffer manipulation currently requires this.
        Assert.that(buf.writePos === 0, 'Message.serialize() requires buf.writePos == 0');

        buf.writeUint32(Message.MAGIC);
        buf.writeVarUint(this._type);
        buf.writeUint32(this.serializedSize);
        buf.writeUint32(0); // written later by _setChecksum()

        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return /*magic*/ 4
            + /*type*/ SerialBuffer.varUintSize(this._type)
            + /*length*/ 4
            + /*checksum*/ 4;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {void}
     * @protected
     */
    _setChecksum(buf) {
        const checksum = CRC32.compute(buf);
        Message._writeChecksum(this._type, buf, checksum);
    }

    /**
     * @param {Message.Type} type
     * @param {SerialBuffer} buf
     * @param {number} value
     * @returns {void}
     * @private
     */
    static _writeChecksum(type, buf, value) {
        // Store current write position.
        const pos = buf.writePos;

        // Set write position past the magic, type, and length fields to the
        // beginning of the checksum value.
        buf.writePos = /*magic*/ 4
            + /*type*/ SerialBuffer.varUintSize(type)
            + /*length*/ 4;

        // Write the checksum value.
        buf.writeUint32(value);

        // Reset the write position to original.
        buf.writePos = pos;
    }

    /** @type {Message.Type} */
    get type() {
        return this._type;
    }
}
Message.MAGIC = 0x42042042;
/**
 * Enum for message types.
 * @enum {number}
 */
Message.Type = {
    VERSION:    0,
    INV:        1,
    GET_DATA:   2,
    GET_HEADER: 3,
    NOT_FOUND:  4,
    GET_BLOCKS: 5,
    BLOCK:      6,
    HEADER:     7,
    TX:         8,
    MEMPOOL:    9,
    REJECT:     10,
    SUBSCRIBE:  11,

    ADDR:       20,
    GET_ADDR:   21,
    PING:       22,
    PONG:       23,

    SIGNAL:     30,

    GET_CHAIN_PROOF:            40,
    CHAIN_PROOF:                41,
    GET_ACCOUNTS_PROOF:         42,
    ACCOUNTS_PROOF:             43,
    GET_ACCOUNTS_TREE_CHUNK:    44,
    ACCOUNTS_TREE_CHUNK:        45,
    ACCOUNTS_REJECTED:          46,
    GET_TRANSACTIONS_PROOF:     47,
    TRANSACTIONS_PROOF:         48,
};
Class.register(Message);

class AddrMessage extends Message {
    /**
     * @param {Array.<PeerAddress>} addresses
     */
    constructor(addresses) {
        super(Message.Type.ADDR);
        if (!addresses || !NumberUtils.isUint16(addresses.length)
            || addresses.some(it => !(it instanceof PeerAddress))) throw 'Malformed addresses';
        this._addresses = addresses;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {AddrMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const addresses = [];
        for (let i = 0; i < count; ++i) {
            addresses.push(PeerAddress.unserialize(buf));
        }
        return new AddrMessage(addresses);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint16(this._addresses.length);
        for (const addr of this._addresses) {
            addr.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = super.serializedSize
            + /*count*/ 2;
        for (const addr of this._addresses) {
            size += addr.serializedSize;
        }
        return size;
    }

    /** @type {Array.<PeerAddress>} */
    get addresses() {
        return this._addresses;
    }
}
Class.register(AddrMessage);

class BlockMessage extends Message {
    /**
     * @param {Block} block
     */
    constructor(block) {
        super(Message.Type.BLOCK);
        // TODO Bitcoin block messages start with a block version
        /** @type {Block} */
        this._block = block;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {BlockMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const block = Block.unserialize(buf);
        return new BlockMessage(block);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._block.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._block.serializedSize;
    }

    /** @type {Block} */
    get block() {
        return this._block;
    }
}
Class.register(BlockMessage);

class GetAddrMessage extends Message {
    /**
     * @param {number} protocolMask
     * @param {number} serviceMask
     */
    constructor(protocolMask, serviceMask) {
        super(Message.Type.GET_ADDR);
        if (!NumberUtils.isUint8(protocolMask)) throw 'Malformed protocolMask';
        if (!NumberUtils.isUint32(serviceMask)) throw 'Malformed serviceMask';
        this._protocolMask = protocolMask;
        this._serviceMask = serviceMask;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {GetAddrMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const protocolMask = buf.readUint8();
        const serviceMask = buf.readUint32();
        return new GetAddrMessage(protocolMask, serviceMask);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint8(this._protocolMask);
        buf.writeUint32(this._serviceMask);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*protocolMask*/ 1
            + /*serviceMask*/ 4;
    }

    /** @type {number} */
    get protocolMask() {
        return this._protocolMask;
    }

    /** @type {number} */
    get serviceMask() {
        return this._serviceMask;
    }
}
Class.register(GetAddrMessage);

class GetBlocksMessage extends Message {
    /**
     * @param {Array.<Hash>} locators
     * @param {number} maxInvSize
     * @param {GetBlocksMessage.Direction} direction
     */
    constructor(locators, maxInvSize=BaseInventoryMessage.VECTORS_MAX_COUNT, direction=GetBlocksMessage.Direction.FORWARD) {
        super(Message.Type.GET_BLOCKS);
        if (!locators || !NumberUtils.isUint16(locators.length)
            || locators.some(it => !Hash.isHash(it))) throw 'Malformed locators';
        if (!NumberUtils.isUint16(maxInvSize)) throw 'Malformed maxInvSize';
        if (!NumberUtils.isUint8(direction)) throw 'Malformed direction';
        /** @type {Array.<Hash>} */
        this._locators = locators;
        this._maxInvSize = maxInvSize;
        this._direction = direction;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {GetBlocksMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const locators = [];
        for (let i = 0; i < count; i++) {
            locators.push(Hash.unserialize(buf));
        }
        const maxInvSize = buf.readUint16();
        const direction = buf.readUint8();
        return new GetBlocksMessage(locators, maxInvSize, direction);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint16(this._locators.length);
        for (const locator of this._locators) {
            locator.serialize(buf);
        }
        buf.writeUint16(this._maxInvSize);
        buf.writeUint8(this._direction);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = super.serializedSize
            + /*count*/ 2
            + /*direction*/ 1
            + /*maxInvSize*/ 2;
        for (const locator of this._locators) {
            size += locator.serializedSize;
        }
        return size;
    }

    /** @type {Array.<Hash>} */
    get locators() {
        return this._locators;
    }

    /** @type {GetBlocksMessage.Direction} */
    get direction() {
        return this._direction;
    }

    /** @type {number} */
    get maxInvSize() {
        return this._maxInvSize;
    }
}
/**
 * @enum {number}
 */
GetBlocksMessage.Direction = {
    FORWARD: 0x1,
    BACKWARD: 0x2
};
Class.register(GetBlocksMessage);

class HeaderMessage extends Message {
    /**
     * @param {BlockHeader} header
     */
    constructor(header) {
        super(Message.Type.HEADER);
        /** @type {BlockHeader} */
        this._header = header;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {HeaderMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const header = BlockHeader.unserialize(buf);
        return new HeaderMessage(header);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @return {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._header.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._header.serializedSize;
    }

    /** @type {BlockHeader} */
    get header() {
        return this._header;
    }
}
Class.register(HeaderMessage);

class InvVector {
    /**
     * @param {Block} block
     * @returns {Promise.<InvVector>}
     */
    static async fromBlock(block) {
        const hash = await block.hash();
        return new InvVector(InvVector.Type.BLOCK, hash);
    }

    /**
     * @param {BlockHeader} header
     * @returns {Promise.<InvVector>}
     */
    static async fromHeader(header) {
        const hash = await header.hash();
        return new InvVector(InvVector.Type.BLOCK, hash);
    }

    /**
     * @param {Transaction} tx
     * @returns {Promise.<InvVector>}
     */
    static async fromTransaction(tx) {
        const hash = await tx.hash();
        return new InvVector(InvVector.Type.TRANSACTION, hash);
    }

    /**
     * @param {InvVector.Type} type
     * @param {Hash} hash
     */
    constructor(type, hash) {
        // TODO validate type
        if (!Hash.isHash(hash)) throw 'Malformed hash';
        /** @type {InvVector.Type} */
        this._type = type;
        /** @type {Hash} */
        this._hash = hash;
    }

    /**
     * @param {SerialBuffer} buf
     * @return {InvVector}
     */
    static unserialize(buf) {
        const type = InvVector.Type.unserialize(buf);
        const hash = Hash.unserialize(buf);
        return new InvVector(type, hash);
    }

    /**
     * @param {?SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        buf.writeUint32(this._type);
        this._hash.serialize(buf);
        return buf;
    }

    /**
     * @param {InvVector} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof InvVector
            && this._type === o.type
            && this._hash.equals(o.hash);
    }

    hashCode() {
        return `${this._type}|${this._hash}`;
    }

    /**
     * @returns {string}
     */
    toString() {
        return `InvVector{type=${this._type}, hash=${this._hash}}`;
    }

    /** @type {number} */
    get serializedSize() {
        return /*invType*/ 4
            + this._hash.serializedSize;
    }

    /** @type {InvVector.Type} */
    get type() {
        return this._type;
    }

    /** @type {Hash} */
    get hash() {
        return this._hash;
    }
}
/**
 * @enum {number}
 */
InvVector.Type = {
    ERROR: 0,
    TRANSACTION: 1,
    BLOCK: 2,

    /**
     * @param {SerialBuffer} buf
     * @returns {InvVector.Type}
     */
    unserialize: function (buf) {
        return /** @type {InvVector.Type} */ (buf.readUint32());
    }
};
Class.register(InvVector);

class BaseInventoryMessage extends Message {
    /**
     * @param {Message.Type} type
     * @param {Array.<InvVector>} vectors
     */
    constructor(type, vectors) {
        super(type);
        if (!vectors || !NumberUtils.isUint16(vectors.length)
            || vectors.some(it => !(it instanceof InvVector))
            || vectors.length > BaseInventoryMessage.VECTORS_MAX_COUNT) throw 'Malformed vectors';
        /** @type {Array.<InvVector>} */
        this._vectors = vectors;
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint16(this._vectors.length);
        for (const vector of this._vectors) {
            vector.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = super.serializedSize
            + /*count*/ 2;
        for (const vector of this._vectors) {
            size += vector.serializedSize;
        }
        return size;
    }

    /** @type {Array.<InvVector>} */
    get vectors() {
        return this._vectors;
    }
}
BaseInventoryMessage.VECTORS_MAX_COUNT = 1000;
Class.register(BaseInventoryMessage);

class InvMessage extends BaseInventoryMessage {
    /**
     * @param {Array.<InvVector>} vectors
     */
    constructor(vectors) {
        super(Message.Type.INV, vectors);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {InvMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const vectors = [];
        for (let i = 0; i < count; ++i) {
            vectors.push(InvVector.unserialize(buf));
        }
        return new InvMessage(vectors);
    }
}
Class.register(InvMessage);

class GetDataMessage extends BaseInventoryMessage {
    /**
     * @param {Array.<InvVector>} vectors
     */
    constructor(vectors) {
        super(Message.Type.GET_DATA, vectors);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetDataMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const vectors = [];
        for (let i = 0; i < count; ++i) {
            vectors.push(InvVector.unserialize(buf));
        }
        return new GetDataMessage(vectors);
    }
}
Class.register(GetDataMessage);

class GetHeaderMessage extends BaseInventoryMessage {
    /**
     * @param {Array.<InvVector>} vectors
     */
    constructor(vectors) {
        super(Message.Type.GET_HEADER, vectors);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetHeaderMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const vectors = [];
        for (let i = 0; i < count; ++i) {
            vectors.push(InvVector.unserialize(buf));
        }
        return new GetHeaderMessage(vectors);
    }
}
Class.register(GetHeaderMessage);

class NotFoundMessage extends BaseInventoryMessage {
    /**
     * @param {Array.<InvVector>} vectors
     */
    constructor(vectors) {
        super(Message.Type.NOT_FOUND, vectors);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {NotFoundMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const count = buf.readUint16();
        const vectors = [];
        for (let i = 0; i < count; ++i) {
            vectors.push(InvVector.unserialize(buf));
        }
        return new NotFoundMessage(vectors);
    }
}
Class.register(NotFoundMessage);

class MempoolMessage extends Message {
    constructor() {
        super(Message.Type.MEMPOOL);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {MempoolMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        return new MempoolMessage();
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize;
    }
}
Class.register(MempoolMessage);

class PingMessage extends Message {
    /**
     * @param {number} nonce
     */
    constructor(nonce) {
        super(Message.Type.PING);
        /** @type {number} */
        this._nonce = nonce;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {PingMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const nonce = buf.readUint32();
        return new PingMessage(nonce);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint32(this._nonce);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*nonce*/ 4;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }
}
Class.register(PingMessage);

class PongMessage extends Message {
    /**
     * @param {number} nonce
     */
    constructor(nonce) {
        super(Message.Type.PONG);
        this._nonce = nonce;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {PongMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const nonce = buf.readUint32();
        return new PongMessage(nonce);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint32(this._nonce);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*nonce*/ 4;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }
}
Class.register(PongMessage);

class RejectMessage extends Message {
    /**
     * @param {Message.Type} messageType
     * @param {RejectMessage.Code} code
     * @param {string} reason
     * @param {Uint8Array} extraData
     */
    constructor(messageType, code, reason, extraData) {
        super(Message.Type.REJECT);
        if (StringUtils.isMultibyte(messageType) || messageType.length > 12) throw 'Malformed type';
        if (!NumberUtils.isUint8(code)) throw 'Malformed code';
        if (StringUtils.isMultibyte(reason) || reason.length > 255) throw 'Malformed reason';
        if (!extraData || !(extraData instanceof Uint8Array) || !NumberUtils.isUint16(extraData.byteLength)) throw 'Malformed extraData';

        /** @type {Message.Type} */
        this._messageType = messageType;
        /** @type {RejectMessage.Code} */
        this._code = code;
        /** @type {string} */
        this._reason = reason;
        /** @type {Uint8Array} */
        this._extraData = extraData;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {RejectMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const messageType = Message.Type.readVarString(buf);
        const code = RejectMessage.Code.read(buf);
        const reason = buf.readVarLengthString();
        const length = buf.readUint16();
        const extraData = buf.read(length);
        return new RejectMessage(messageType, code, reason, extraData);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeVarLengthString(this._messageType);
        buf.writeUint8(this._code);
        buf.writeVarLengthString(this._reason);
        buf.writeUint16(this._extraData.byteLength);
        buf.write(this._extraData);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*messageType VarLengthString extra byte*/ 1
            + this._messageType.length
            + /*code*/ 1
            + /*reason VarLengthString extra byte*/ 1
            + this._reason.length
            + /*extraDataLength*/ 2
            + this._extraData.byteLength;
    }

    /** @type {Message.Type} */
    get messageType() {
        return this._messageType;
    }

    /** @type {RejectMessage.Code} */
    get code() {
        return this._code;
    }

    /** @type {string} */
    get reason() {
        return this._reason;
    }

    /** @type {Uint8Array} */
    get extraData() {
        return this._extraData;
    }
}
/**
 * @enum {number}
 */
RejectMessage.Code = {
    DUPLICATE: 0x12,

    /**
     * @param {SerialBuffer} buf
     * @returns {RejectMessage.Code}
     */
    read: function (buf) {
        return /** @type {RejectMessage.Code} */ (buf.readUint8());
    }
};
Class.register(RejectMessage);

class SignalMessage extends Message {
    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     * @param {number} ttl
     * @param {SignalMessage.Flags|number} flags
     * @param {Uint8Array} [payload]
     * @param {PublicKey} [senderPubKey]
     * @param {Signature} [signature]
     */
    constructor(senderId, recipientId, nonce, ttl, flags = 0, payload = new Uint8Array(0), senderPubKey, signature) {
        super(Message.Type.SIGNAL);
        if (!(senderId instanceof SignalId)) throw 'Malformed senderId';
        if (!(recipientId instanceof SignalId)) throw 'Malformed recipientId';
        if (!NumberUtils.isUint32(nonce)) throw 'Malformed nonce';
        if (!NumberUtils.isUint8(ttl)) throw 'Malformed ttl';
        if (!NumberUtils.isUint8(flags)) throw 'Malformed flags';
        if (!(payload instanceof Uint8Array) || !NumberUtils.isUint16(payload.byteLength)) throw 'Malformed payload';
        const hasPayload = payload.byteLength > 0;
        if (hasPayload && !(signature instanceof Signature)) throw 'Malformed signature';
        if (hasPayload && !(senderPubKey instanceof PublicKey)) throw 'Malformed public key';

        // Note that the signature is NOT verified here.
        // Callers must explicitly invoke verifySignature() to check it.

        this._senderId = senderId;
        this._recipientId = recipientId;
        this._nonce = nonce;
        this._ttl = ttl;
        this._flags = flags;
        this._payload = payload;
        this._senderPubKey = hasPayload ? senderPubKey : undefined;
        this._signature = hasPayload ? signature : undefined;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {SignalMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const senderId = SignalId.unserialize(buf);
        const recipientId = SignalId.unserialize(buf);
        const nonce = buf.readUint32();
        const ttl = buf.readUint8();
        const flags = buf.readUint8();
        const length = buf.readUint16();
        const payload = buf.read(length);
        const senderPubKey = length > 0 ? PublicKey.unserialize(buf) : undefined;
        const signature = length > 0 ? Signature.unserialize(buf) : undefined;
        return new SignalMessage(senderId, recipientId, nonce, ttl, flags, payload, senderPubKey, signature);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._senderId.serialize(buf);
        this._recipientId.serialize(buf);
        buf.writeUint32(this._nonce);
        buf.writeUint8(this._ttl);
        buf.writeUint8(this._flags);
        buf.writeUint16(this._payload.byteLength);
        buf.write(this._payload);
        if (this._payload.byteLength > 0) {
            this._senderPubKey.serialize(buf);
            this._signature.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*senderId*/ this._senderId.serializedSize
            + /*recipientId*/ this._recipientId.serializedSize
            + /*nonce*/ 4
            + /*ttl*/ 1
            + /*flags*/ 1
            + /*payloadLength*/ 2
            + this._payload.byteLength
            + (this._payload.byteLength > 0 ? this._senderPubKey.serializedSize : 0)
            + (this._payload.byteLength > 0 ? this._signature.serializedSize : 0);
    }

    /**
     * @return {Promise.<boolean>}
     */
    async verifySignature() {
        if (!this._signature) {
            return false;
        }
        return (await this._signature.verify(this._senderPubKey, this._payload)) && this._senderId.equals(await this._senderPubKey.toSignalId());
    }

    /** @type {SignalId} */
    get senderId() {
        return this._senderId;
    }

    /** @type {SignalId} */
    get recipientId() {
        return this._recipientId;
    }

    /** @type {number} */
    get nonce() {
        return this._nonce;
    }

    /** @type {number} */
    get ttl() {
        return this._ttl;
    }

    /** @type {SignalMessage.Flags|number} */
    get flags() {
        return this._flags;
    }

    /** @type {Uint8Array} */
    get payload() {
        return this._payload;
    }

    /** @type {Signature} */
    get signature() {
        return this._signature;
    }

    /** @type {PublicKey} */
    get senderPubKey() {
        return this._senderPubKey;
    }

    /**
     * @returns {boolean}
     */
    hasPayload() {
        return this._payload.byteLength > 0;
    }

    /**
     * @returns {boolean}
     */
    isUnroutable() {
        return (this._flags & SignalMessage.Flags.UNROUTABLE) !== 0;
    }

    /**
     * @returns {boolean}
     */
    isTtlExceeded() {
        return (this._flags & SignalMessage.Flags.TTL_EXCEEDED) !== 0;
    }
}
/**
 * @enum {number}
 */
SignalMessage.Flags = {
    UNROUTABLE: 0x1,
    TTL_EXCEEDED: 0x2
};
Class.register(SignalMessage);

class SubscribeMessage extends Message {
    constructor(subscription) {
        super(Message.Type.SUBSCRIBE);
        this._subscription = subscription;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {SubscribeMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const subscription = Subscription.unserialize(buf);
        return new SubscribeMessage(subscription);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._subscription.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._subscription.serializedSize;
    }

    /** @type {Subscription} */
    get subscription() {
        return this._subscription;
    }
}
Class.register(SubscribeMessage);

class TxMessage extends Message {
    /**
     * @param {Transaction} transaction
     * @param {?AccountsProof} [accountsProof]
     */
    constructor(transaction, accountsProof) {
        super(Message.Type.TX);
        /** @type {Transaction} */
        this._transaction = transaction;
        /** @type {AccountsProof} */
        this._accountsProof = accountsProof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {TxMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const transaction = Transaction.unserialize(buf);
        const hasAccountsProof = buf.readUint8();
        if (hasAccountsProof === 1) {
            const accountsProof = AccountsProof.unserialize(buf);
            return new TxMessage(transaction, accountsProof);
        }
        return new TxMessage(transaction);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._transaction.serialize(buf);
        buf.writeUint8(this._accountsProof ? 1 : 0);
        if (this._accountsProof) {
            this._accountsProof.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        let size = super.serializedSize
            + this._transaction.serializedSize
            + /*hasAccountsProof*/ 1;
        if (this._accountsProof) {
            size += this._accountsProof.serializedSize;
        }
        return size;
    }

    /** @type {Transaction} */
    get transaction() {
        return this._transaction;
    }

    /** @type {boolean} */
    get hasAccountsProof() {
        return !!this._accountsProof;
    }

    /** @type {AccountsProof} */
    get accountsProof() {
        return this._accountsProof;
    }
}
Class.register(TxMessage);

class VersionMessage extends Message {
    /**
     * @param {number} version
     * @param {PeerAddress} peerAddress
     * @param {Hash} genesisHash
     * @param {Hash} headHash
     */
    constructor(version, peerAddress, genesisHash, headHash) {
        super(Message.Type.VERSION);
        if (!NumberUtils.isUint32(version)) throw 'Malformed version';
        if (!peerAddress || !(peerAddress instanceof PeerAddress)) throw 'Malformed peerAddress';
        if (!Hash.isHash(genesisHash)) throw 'Malformed genesisHash';
        if (!Hash.isHash(headHash)) throw 'Malformed headHash';

        /** @type {number} */
        this._version = version;
        /** @type {PeerAddress} */
        this._peerAddress = peerAddress;
        /** @type {Hash} */
        this._genesisHash = genesisHash;
        /** @type {Hash} */
        this._headHash = headHash;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {VersionMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const version = buf.readUint32();
        const peerAddress = PeerAddress.unserialize(buf);
        const genesisHash = Hash.unserialize(buf);
        const headHash = Hash.unserialize(buf);
        return new VersionMessage(version, peerAddress, genesisHash, headHash);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        buf.writeUint32(this._version);
        this._peerAddress.serialize(buf);
        this._genesisHash.serialize(buf);
        this._headHash.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + /*version*/ 4
            + this._peerAddress.serializedSize
            + this._genesisHash.serializedSize
            + this._headHash.serializedSize;
    }

    /** @type {number} */
    get version() {
        return this._version;
    }

    /** @type {PeerAddress} */
    get peerAddress() {
        return this._peerAddress;
    }

    /** @type {Hash} */
    get genesisHash() {
        return this._genesisHash;
    }

    /** @type {Hash} */
    get headHash() {
        return this._headHash;
    }
}
Class.register(VersionMessage);

class AccountsProofMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {AccountsProof} accountsProof
     */
    constructor(blockHash, accountsProof) {
        super(Message.Type.ACCOUNTS_PROOF);
        if (!(blockHash instanceof Hash)) throw new Error('Malformed blockHash');
        if (!(accountsProof instanceof AccountsProof)) throw new Error('Malformed proof');
        /** @type {Hash} */
        this._blockHash = blockHash;
        /** @type {AccountsProof} */
        this._accountsProof = accountsProof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const accountsProof = AccountsProof.unserialize(buf);
        return new AccountsProofMessage(blockHash, accountsProof);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        this._accountsProof.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + this._accountsProof.serializedSize;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }

    /** @type {AccountsProof} */
    get proof() {
        return this._accountsProof;
    }
}
Class.register(AccountsProofMessage);

class GetAccountsProofMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     */
    constructor(blockHash, addresses) {
        super(Message.Type.GET_ACCOUNTS_PROOF);
        if (!blockHash || !(blockHash instanceof Hash)) throw new Error('Malformed block hash');
        if (!addresses || !NumberUtils.isUint16(addresses.length)
            || addresses.some(it => !(it instanceof Address))) throw new Error('Malformed addresses');
        this._blockHash = blockHash;
        /** @type {Array.<Address>} */
        this._addresses = addresses;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetAccountsProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const count = buf.readUint16();
        const addresses = [];
        for (let i = 0; i < count; i++) {
            addresses.push(Address.unserialize(buf));
        }
        return new GetAccountsProofMessage(blockHash, addresses);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        buf.writeUint16(this._addresses.length);
        for (const address of this._addresses) {
            address.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + /*count*/ 2
            + this._addresses.reduce((sum, address) => sum + address.serializedSize, 0);
    }

    /** @type {Array.<Address>} */
    get addresses() {
        return this._addresses;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }
}
Class.register(GetAccountsProofMessage);

class ChainProofMessage extends Message {
    /**
     * @param {ChainProof} proof
     */
    constructor(proof) {
        super(Message.Type.CHAIN_PROOF);
        if (!(proof instanceof ChainProof)) throw 'Malformed chainProof';

        /** @type {ChainProof} */
        this._proof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {ChainProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const proof = ChainProof.unserialize(buf);
        return new ChainProofMessage(proof);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._proof.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._proof.serializedSize;
    }

    /** @type {ChainProof} */
    get proof() {
        return this._proof;
    }
}
Class.register(ChainProofMessage);

class GetChainProofMessage extends Message {
    constructor() {
        super(Message.Type.GET_CHAIN_PROOF);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetChainProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        return new GetChainProofMessage();
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize;
    }
}
Class.register(GetChainProofMessage);

class AccountsTreeChunkMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {AccountsTreeChunk} accountsTreeChunk
     */
    constructor(blockHash, accountsTreeChunk) {
        super(Message.Type.ACCOUNTS_TREE_CHUNK);
        if (!(blockHash instanceof Hash)) throw 'Malformed blockHash';
        if (!(accountsTreeChunk instanceof AccountsTreeChunk)) throw 'Malformed chunk';
        /** @type {Hash} */
        this._blockHash = blockHash;
        /** @type {AccountsTreeChunk} */
        this._accountsTreeChunk = accountsTreeChunk;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsTreeChunkMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const accountsTreeChunk = AccountsTreeChunk.unserialize(buf);
        return new AccountsTreeChunkMessage(blockHash, accountsTreeChunk);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        this._accountsTreeChunk.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + this._accountsTreeChunk.serializedSize;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }

    /** @type {AccountsTreeChunk} */
    get chunk() {
        return this._accountsTreeChunk;
    }
}
Class.register(AccountsTreeChunkMessage);

class GetAccountsTreeChunkMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {string} startPrefix
     */
    constructor(blockHash, startPrefix) {
        super(Message.Type.GET_ACCOUNTS_TREE_CHUNK);
        if (!blockHash || !(blockHash instanceof Hash)) throw 'Malformed block hash';
        if (StringUtils.isMultibyte(startPrefix)
            || !NumberUtils.isUint8(startPrefix.length)) throw 'Malformed start prefix';
        /** @type {Hash} */
        this._blockHash = blockHash;
        this._startPrefix = startPrefix;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetAccountsTreeChunkMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const startPrefix = buf.readVarLengthString();
        return new GetAccountsTreeChunkMessage(blockHash, startPrefix);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        buf.writeVarLengthString(this._startPrefix);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + /*length of prefix*/ 1
            + this._startPrefix.length;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }

    /** @type {string} */
    get startPrefix() {
        return this._startPrefix;
    }
}
Class.register(GetAccountsTreeChunkMessage);

class AccountsRejectedMessage extends Message {
    constructor() {
        super(Message.Type.ACCOUNTS_REJECTED);
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {AccountsTreeChunkMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        return new AccountsRejectedMessage();
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize;
    }
}
Class.register(AccountsRejectedMessage);

class TransactionsProofMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {TransactionsProof} proof
     */
    constructor(blockHash, proof) {
        super(Message.Type.TRANSACTIONS_PROOF);
        if (!(blockHash instanceof Hash)) throw new Error('Malformed blockHash');
        if (!(proof instanceof TransactionsProof)) throw new Error('Malformed proof');
        /** @type {Hash} */
        this._blockHash = blockHash;
        /** @type {TransactionsProof} */
        this._proof = proof;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {TransactionsProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const proof = TransactionsProof.unserialize(buf);
        return new TransactionsProofMessage(blockHash, proof);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        this._proof.serialize(buf);
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + this._proof.serializedSize;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }

    /** @type {TransactionsProof} */
    get proof() {
        return this._proof;
    }
}
Class.register(TransactionsProofMessage);

class GetTransactionsProofMessage extends Message {
    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     */
    constructor(blockHash, addresses) {
        super(Message.Type.GET_TRANSACTIONS_PROOF);
        if (!blockHash || !(blockHash instanceof Hash)) throw new Error('Malformed block hash');
        if (!addresses || !NumberUtils.isUint16(addresses.length)
            || addresses.some(it => !(it instanceof Address))) throw new Error('Malformed addresses');
        this._blockHash = blockHash;
        /** @type {Array.<Address>} */
        this._addresses = addresses;
    }

    /**
     * @param {SerialBuffer} buf
     * @returns {GetTransactionsProofMessage}
     */
    static unserialize(buf) {
        Message.unserialize(buf);
        const blockHash = Hash.unserialize(buf);
        const count = buf.readUint16();
        const addresses = [];
        for (let i = 0; i < count; i++) {
            addresses.push(Address.unserialize(buf));
        }
        return new GetTransactionsProofMessage(blockHash, addresses);
    }

    /**
     * @param {SerialBuffer} [buf]
     * @returns {SerialBuffer}
     */
    serialize(buf) {
        buf = buf || new SerialBuffer(this.serializedSize);
        super.serialize(buf);
        this._blockHash.serialize(buf);
        buf.writeUint16(this._addresses.length);
        for (const address of this._addresses) {
            address.serialize(buf);
        }
        super._setChecksum(buf);
        return buf;
    }

    /** @type {number} */
    get serializedSize() {
        return super.serializedSize
            + this._blockHash.serializedSize
            + /*count*/ 2
            + this._addresses.reduce((sum, address) => sum + address.serializedSize, 0);
    }

    /** @type {Array.<Address>} */
    get addresses() {
        return this._addresses;
    }

    /** @type {Hash} */
    get blockHash() {
        return this._blockHash;
    }
}
Class.register(GetTransactionsProofMessage);

class MessageFactory {
    static parse(buffer) {
        const buf = new SerialBuffer(buffer);
        const type = Message.peekType(buf);
        const clazz = MessageFactory.CLASSES[type];
        if (!clazz || !clazz.unserialize) throw `Invalid message type: ${type}`;
        return clazz.unserialize(buf);
    }
}
/**
 * @dict 
 * @type {object}
 */
MessageFactory.CLASSES = {};
MessageFactory.CLASSES[Message.Type.VERSION] = VersionMessage;
MessageFactory.CLASSES[Message.Type.INV] = InvMessage;
MessageFactory.CLASSES[Message.Type.GET_DATA] = GetDataMessage;
MessageFactory.CLASSES[Message.Type.GET_HEADER] = GetHeaderMessage;
MessageFactory.CLASSES[Message.Type.NOT_FOUND] = NotFoundMessage;
MessageFactory.CLASSES[Message.Type.BLOCK] = BlockMessage;
MessageFactory.CLASSES[Message.Type.HEADER] = HeaderMessage;
MessageFactory.CLASSES[Message.Type.TX] = TxMessage;
MessageFactory.CLASSES[Message.Type.GET_BLOCKS] = GetBlocksMessage;
MessageFactory.CLASSES[Message.Type.MEMPOOL] = MempoolMessage;
MessageFactory.CLASSES[Message.Type.REJECT] = RejectMessage;
MessageFactory.CLASSES[Message.Type.SUBSCRIBE] = SubscribeMessage;
MessageFactory.CLASSES[Message.Type.ADDR] = AddrMessage;
MessageFactory.CLASSES[Message.Type.GET_ADDR] = GetAddrMessage;
MessageFactory.CLASSES[Message.Type.PING] = PingMessage;
MessageFactory.CLASSES[Message.Type.PONG] = PongMessage;
MessageFactory.CLASSES[Message.Type.SIGNAL] = SignalMessage;
MessageFactory.CLASSES[Message.Type.GET_CHAIN_PROOF] = GetChainProofMessage;
MessageFactory.CLASSES[Message.Type.CHAIN_PROOF] = ChainProofMessage;
MessageFactory.CLASSES[Message.Type.GET_ACCOUNTS_PROOF] = GetAccountsProofMessage;
MessageFactory.CLASSES[Message.Type.ACCOUNTS_PROOF] = AccountsProofMessage;
MessageFactory.CLASSES[Message.Type.GET_ACCOUNTS_TREE_CHUNK] = GetAccountsTreeChunkMessage;
MessageFactory.CLASSES[Message.Type.ACCOUNTS_TREE_CHUNK] = AccountsTreeChunkMessage;
MessageFactory.CLASSES[Message.Type.ACCOUNTS_REJECTED] = AccountsRejectedMessage;
MessageFactory.CLASSES[Message.Type.GET_TRANSACTIONS_PROOF] = GetTransactionsProofMessage;
MessageFactory.CLASSES[Message.Type.TRANSACTIONS_PROOF] = TransactionsProofMessage;
Class.register(MessageFactory);

class NetworkAgent extends Observable {
    /**
     * @param {IBlockchain} blockchain
     * @param {PeerAddresses} addresses
     * @param {PeerChannel} channel
     *
     * @listens PeerChannel#version
     * @listens PeerChannel#addr
     * @listens PeerChannel#getAddr
     * @listens PeerChannel#ping
     * @listens PeerChannel#pong
     * @listens PeerChannel#close
     */
    constructor(blockchain, addresses, channel) {
        super();
        /** @type {IBlockchain} */
        this._blockchain = blockchain;
        /** @type {PeerAddresses} */
        this._addresses = addresses;
        /** @type {PeerChannel} */
        this._channel = channel;

        /**
         * The peer object we create after the handshake completes.
         * @type {Peer}
         * @private
         */
        this._peer = null;

        /**
         * All peerAddresses that we think the remote peer knows.
         * @type {HashSet.<PeerAddress>}
         * @private
         */
        this._knownAddresses = new HashSet();

        /**
         * Helper object to keep track of timeouts & intervals.
         * @type {Timers}
         * @private
         */
        this._timers = new Timers();

        /**
         * True if we have received the peer's version message.
         * @type {boolean}
         * @private
         */
        this._versionReceived = false;

        /**
         * True if we have successfully sent our version message.
         * @type {boolean}
         * @private
         */
        this._versionSent = false;

        /**
         * Number of times we have tried to send out the version message.
         * @type {number}
         * @private
         */
        this._versionAttempts = 0;

        // Listen to network/control messages from the peer.
        channel.on('version', msg => this._onVersion(msg));
        channel.on('addr', msg => this._onAddr(msg));
        channel.on('get-addr', msg => this._onGetAddr(msg));
        channel.on('ping', msg => this._onPing(msg));
        channel.on('pong', msg => this._onPong(msg));

        // Clean up when the peer disconnects.
        channel.on('close', closedByRemote => this._onClose(closedByRemote));
    }

    /**
     * @param {Array.<PeerAddress|RtcPeerAddress>} addresses
     */
    relayAddresses(addresses) {
        // Don't relay if the handshake hasn't finished yet.
        if (!this._versionReceived || !this._versionSent) {
            return;
        }

        // Only relay addresses that the peer doesn't know yet. If the address
        // the peer knows is older than RELAY_THROTTLE, relay the address again.
        const filteredAddresses = addresses.filter(addr => {
            // Exclude RTC addresses that are already at MAX_DISTANCE.
            if (addr.protocol === Protocol.RTC && addr.distance >= PeerAddresses.MAX_DISTANCE) {
                return false;
            }

            // Exclude DumbPeerAddresses.
            if (addr.protocol === Protocol.DUMB) {
                return false;
            }

            const knownAddress = this._knownAddresses.get(addr);
            return !addr.isSeed() // Never relay seed addresses.
                && (!knownAddress || knownAddress.timestamp < Date.now() - NetworkAgent.RELAY_THROTTLE);
        });

        if (filteredAddresses.length) {
            this._channel.addr(filteredAddresses);

            // We assume that the peer knows these addresses now.
            for (const address of filteredAddresses) {
                this._knownAddresses.add(address);
            }
        }
    }


    /* Handshake */

    handshake() {
        // Kick off the handshake by telling the peer our version, network address & blockchain head hash.
        // Firefox sends the data-channel-open event too early, so sending the version message might fail.
        // Try again in this case.
        if (!this._channel.version(NetworkConfig.myPeerAddress(), this._blockchain.headHash)) {
            this._versionAttempts++;
            if (this._versionAttempts >= NetworkAgent.VERSION_ATTEMPTS_MAX) {
                this._channel.close('sending of version message failed');
                return;
            }

            setTimeout(this.handshake.bind(this), NetworkAgent.VERSION_RETRY_DELAY);
            return;
        }

        this._versionSent = true;

        // Drop the peer if it doesn't send us a version message.
        // Only do this if we haven't received the peer's version message already.
        if (!this._versionReceived) {
            // TODO Should we ban instead?
            this._timers.setTimeout('version', () => {
                this._timers.clearTimeout('version');
                this._channel.close('version timeout');
            }, NetworkAgent.HANDSHAKE_TIMEOUT);
        } else {
            // The peer has sent us his version message already.
            this._finishHandshake();
        }
    }

    /**
     * @param {VersionMessage} msg
     * @private
     */
    _onVersion(msg) {
        Log.d(NetworkAgent, () => `[VERSION] ${msg.peerAddress} ${msg.headHash.toBase64()}`);

        const now = Date.now();

        // Make sure this is a valid message in our current state.
        if (!this._canAcceptMessage(msg)) {
            return;
        }

        // Clear the version timeout.
        this._timers.clearTimeout('version');

        // Check if the peer is running a compatible version.
        if (!Version.isCompatible(msg.version)) {
            this._channel.close(`incompatible version (ours=${Version.CODE}, theirs=${msg.version})`);
            return;
        }

        // Check if the peer is working on the same genesis block.
        if (!Block.GENESIS.HASH.equals(msg.genesisHash)) {
            this._channel.close(`different genesis block (${msg.genesisHash})`);
            return;
        }

        // TODO check services?

        // Check that the given peerAddress matches the one we expect.
        // In case of inbound WebSocket connections, this is the first time we
        // see the remote peer's peerAddress.
        // TODO We should validate that the given peerAddress actually resolves
        // to the peer's netAddress!
        if (this._channel.peerAddress) {
            if (!this._channel.peerAddress.equals(msg.peerAddress)) {
                this._channel.close('unexpected peerAddress in version message');
                return;
            }
        }

        // The client might not send its netAddress. Set it from our address database if we have it.
        const peerAddress = msg.peerAddress;
        if (!peerAddress.netAddress) {
            /** @type {PeerAddress} */
            const storedAddress = this._addresses.get(peerAddress);
            if (storedAddress && storedAddress.netAddress) {
                peerAddress.netAddress = storedAddress.netAddress;
            }
        }
        this._channel.peerAddress = peerAddress;

        // Create peer object. Since the initial version message received from the
        // peer contains their local timestamp, we can use it to calculate their
        // offset to our local timestamp and store it for later (last argument).
        this._peer = new Peer(
            this._channel,
            msg.version,
            msg.headHash,
            peerAddress.timestamp - now
        );

        // Remember that the peer has sent us this address.
        this._knownAddresses.add(peerAddress);

        this._versionReceived = true;

        if (this._versionSent) {
            this._finishHandshake();
        }
    }

    _finishHandshake() {
        // Setup regular connectivity check.
        // TODO randomize interval?
        this._timers.setInterval('connectivity',
            () => this._checkConnectivity(),
            NetworkAgent.CONNECTIVITY_CHECK_INTERVAL);

        // Regularly announce our address.
        this._timers.setInterval('announce-addr',
            () => this._channel.addr([NetworkConfig.myPeerAddress()]),
            NetworkAgent.ANNOUNCE_ADDR_INTERVAL);

        // Tell listeners about the new peer that connected.
        this.fire('handshake', this._peer, this);

        // Request new network addresses from the peer.
        this._requestAddresses();
    }


    /* Addresses */

    _requestAddresses() {
        // Request addresses from peer.
        this._channel.getAddr(NetworkConfig.myProtocolMask(), Services.myServiceMask());

        // We don't use a timeout here. The peer will not respond with an addr message if
        // it doesn't have any new addresses.
    }

    /**
     * @param {AddrMessage} msg
     * @return {Promise}
     * @private
     */
    async _onAddr(msg) {
        // Make sure this is a valid message in our current state.
        if (!this._canAcceptMessage(msg)) {
            return;
        }

        // Reject messages that contain more than 1000 addresses, ban peer (bitcoin).
        if (msg.addresses.length > 1000) {
            Log.w(NetworkAgent, 'Rejecting addr message - too many addresses');
            this._channel.ban('addr message too large');
            return;
        }

        // Remember that the peer has sent us these addresses.
        for (const addr of msg.addresses) {
            this._knownAddresses.add(addr);
        }

        // Put the new addresses in the address pool.
        await this._addresses.add(this._channel, msg.addresses);

        // Tell listeners that we have received new addresses.
        this.fire('addr', msg.addresses, this);
    }

    /**
     * @param {GetAddrMessage} msg
     * @private
     */
    _onGetAddr(msg) {
        // Make sure this is a valid message in our current state.
        if (!this._canAcceptMessage(msg)) {
            return;
        }

        // Find addresses that match the given serviceMask.
        const addresses = this._addresses.query(msg.protocolMask, msg.serviceMask);

        const filteredAddresses = addresses.filter(addr => {
            // Exclude RTC addresses that are already at MAX_DISTANCE.
            if (addr.protocol === Protocol.RTC && addr.distance >= PeerAddresses.MAX_DISTANCE) {
                return false;
            }

            // Exclude known addresses from the response unless they are older than RELAY_THROTTLE.
            const knownAddress = this._knownAddresses.get(addr);
            return !knownAddress || knownAddress.timestamp < Date.now() - NetworkAgent.RELAY_THROTTLE;
        });

        // Send the addresses back to the peer.
        // If we don't have any new addresses, don't send the message at all.
        if (filteredAddresses.length) {
            this._channel.addr(filteredAddresses);
        }
    }


    /* Connectivity Check */

    _checkConnectivity() {
        // Generate random nonce.
        const nonce = NumberUtils.randomUint32();

        // Send ping message to peer.
        // If sending the ping message fails, assume the connection has died.
        if (!this._channel.ping(nonce)) {
            this._channel.close('sending ping message failed');
            return;
        }

        // Drop peer if it doesn't answer with a matching pong message within the timeout.
        this._timers.setTimeout(`ping_${nonce}`, () => {
            this._timers.clearTimeout(`ping_${nonce}`);
            this._channel.fail('ping timeout');
        }, NetworkAgent.PING_TIMEOUT);
    }

    /**
     * @param {PingMessage} msg
     * @private
     */
    _onPing(msg) {
        // Make sure this is a valid message in our current state.
        if (!this._canAcceptMessage(msg)) {
            return;
        }

        // Respond with a pong message
        this._channel.pong(msg.nonce);
    }

    /**
     * @param {PongMessage} msg
     * @private
     */
    _onPong(msg) {
        // Clear the ping timeout for this nonce.
        this._timers.clearTimeout(`ping_${msg.nonce}`);
    }

    /**
     * @param {boolean} closedByRemote
     * @private
     */
    _onClose(closedByRemote) {
        // Clear all timers and intervals when the peer disconnects.
        this._timers.clearAll();

        // Tell listeners that the peer has disconnected.
        this.fire('close', this._peer, this._channel, closedByRemote, this);
    }

    /**
     * @param {Message} msg
     * @return {boolean}
     * @private
     */
    _canAcceptMessage(msg) {
        // The first message must be the version message.
        if (!this._versionReceived && msg.type !== Message.Type.VERSION) {
            Log.w(NetworkAgent, `Discarding ${msg.type} message from ${this._channel}`
                + ' - no version message received previously');
            return false;
        }
        return true;
    }

    /** @type {PeerChannel} */
    get channel() {
        return this._channel;
    }

    /** @type {Peer} */
    get peer() {
        return this._peer;
    }
}
NetworkAgent.HANDSHAKE_TIMEOUT = 1000 * 3; // 3 seconds
NetworkAgent.PING_TIMEOUT = 1000 * 10; // 10 seconds
NetworkAgent.CONNECTIVITY_CHECK_INTERVAL = 1000 * 60; // 1 minute
NetworkAgent.ANNOUNCE_ADDR_INTERVAL = 1000 * 60 * 5; // 5 minutes
NetworkAgent.RELAY_THROTTLE = 1000 * 60 * 2; // 2 minutes
NetworkAgent.VERSION_ATTEMPTS_MAX = 10;
NetworkAgent.VERSION_RETRY_DELAY = 500; // 500 ms
Class.register(NetworkAgent);

class Network extends Observable {
    /**
     * @type {number}
     * @constant
     */
    static get PEER_COUNT_MAX() {
        return PlatformUtils.isBrowser() ? 15 : 50000;
    }

    /**
     * @type {number}
     * @constant
     */
    static get PEER_COUNT_PER_IP_WS_MAX() {
        return PlatformUtils.isBrowser() ? 1 : 25;
    }

    /**
     * @type {number}
     * @constant
     */
    static get PEER_COUNT_PER_IP_RTC_MAX() {
        return 2;
    }

    /**
     * @param {IBlockchain} blockchain
     * @return {Promise.<Network>}
     */
    constructor(blockchain) {
        super();
        /** @type {IBlockchain} */
        this._blockchain = blockchain;
        return this._init();
    }

    /**
     * @listens PeerAddresses#added
     * @listens WebSocketConnector#connection
     * @listens WebSocketConnector#error
     * @listens WebRtcConnector#connection
     * @listens WebRtcConnector#error
     * @return {Promise.<Network>}
     * @private
     */
    async _init() {
        /**
         * Flag indicating whether we should actively connect to other peers
         * if our peer count is below PEER_COUNT_DESIRED.
         * @type {boolean}
         * @private
         */
        this._autoConnect = false;

        /**
         * Backoff for peer count check in seconds.
         * @type {number}
         * @private
         */
        this._backoff = Network.CONNECT_BACKOFF_INITIAL;

        /**
         * Flag indicating whether we already triggered a backoff.
         * @type {boolean}
         * @private
         */
        this._backedOff = false;

        /**
         * Map of agents indexed by connection ids.
         * @type {HashMap.<number,NetworkAgent>}
         * @private
         */
        this._agents = new HashMap();

        // Total bytes sent/received on past connections.
        /** @type {number} */
        this._bytesSent = 0;
        /** @type {number} */
        this._bytesReceived = 0;

        /** @type {WebSocketConnector} */
        this._wsConnector = new WebSocketConnector();
        this._wsConnector.on('connection', conn => this._onConnection(conn));
        this._wsConnector.on('error', peerAddr => this._onError(peerAddr));

        /** @type {WebRtcConnector} */
        this._rtcConnector = await new WebRtcConnector();
        this._rtcConnector.on('connection', conn => this._onConnection(conn));
        this._rtcConnector.on('error', (peerAddr, reason) => this._onError(peerAddr, reason));

        /**
         * Helper objects to manage PeerAddresses.
         * Must be initialized AFTER the WebSocket/WebRtcConnector.
         * @type {PeerAddresses}
         * @private
         */
        this._addresses = new PeerAddresses();

        // Relay new addresses to peers.
        this._addresses.on('added', addresses => {
            this._relayAddresses(addresses);
            this._checkPeerCount();
        });

        /** @type {SignalStore} */
        this._forwards = new SignalStore();

        return this;
    }

    connect() {
        this._autoConnect = true;

        // Start connecting to peers.
        this._checkPeerCount();
    }

    /**
     * @param {string|*} reason
     */
    disconnect(reason) {
        this._autoConnect = false;

        // Close all active connections.
        for (const agent of this._agents.values()) {
            agent.channel.close(reason || 'manual network disconnect');
        }
    }

    // XXX For testing
    disconnectWebSocket() {
        this._autoConnect = false;

        // Close all websocket connections.
        for (const agent of this._agents.values()) {
            if (agent.peer.peerAddress.protocol === Protocol.WS) {
                agent.channel.close('manual websocket disconnect');
            }
        }
    }

    /**
     * @param {Array.<PeerAddress>} addresses
     * @returns {void}
     * @private
     */
    _relayAddresses(addresses) {
        // Pick PEER_COUNT_RELAY random peers and relay addresses to them if:
        // - number of addresses <= 10
        // TODO more restrictions, see Bitcoin
        if (addresses.length > 10) {
            return;
        }

        // XXX We don't protect against picking the same peer more than once.
        // The NetworkAgent will take care of not sending the addresses twice.
        // In that case, the address will simply be relayed to less peers. Also,
        // the peer that we pick might already know the address.
        const agents = this._agents.values();
        for (let i = 0; i < Network.PEER_COUNT_RELAY; ++i) {
            const agent = ArrayUtils.randomElement(agents);
            if (agent) {
                agent.relayAddresses(addresses);
            }
        }
    }

    _checkPeerCount() {
        if (this._autoConnect
            && this.peerCount + this._addresses.connectingCount < Network.PEER_COUNT_DESIRED
            && this._addresses.connectingCount < Network.CONNECTING_COUNT_MAX) {

            // Pick a peer address that we are not connected to yet.
            const peerAddress = this._addresses.pickAddress();

            // We can't connect if we don't know any more addresses.
            if (!peerAddress) {
                // If no backoff has been triggered, trigger one.
                // This helps us to check back whether we need more connections.
                if (!this._backedOff) {
                    this._backedOff = true;
                    const oldBackoff = this._backoff;
                    this._backoff = Math.min(Network.CONNECT_BACKOFF_MAX, oldBackoff * 2);
                    setTimeout(() => {
                        this._backedOff = false;
                        this._checkPeerCount();
                    }, oldBackoff);
                }
                return;
            }

            // Connect to this address.
            this._connect(peerAddress);
        }
        this._backoff = Network.CONNECT_BACKOFF_INITIAL;
    }

    /**
     * @param {PeerAddress} peerAddress
     * @returns {void}
     * @private
     */
    _connect(peerAddress) {
        switch (peerAddress.protocol) {
            case Protocol.WS:
                Log.d(Network, `Connecting to ${peerAddress} ...`);
                if (this._wsConnector.connect(peerAddress)) {
                    this._addresses.connecting(peerAddress);
                }
                break;

            case Protocol.RTC: {
                const signalChannel = this._addresses.getChannelBySignalId(peerAddress.signalId);
                Log.d(Network, `Connecting to ${peerAddress} via ${signalChannel.peerAddress}...`);
                if (this._rtcConnector.connect(peerAddress, signalChannel)) {
                    this._addresses.connecting(peerAddress);
                }
                break;
            }

            default:
                Log.e(Network, `Cannot connect to ${peerAddress} - unsupported protocol`);
                this._onError(peerAddress);
        }
    }

    /**
     * @listens PeerChannel#signal
     * @listens PeerChannel#ban
     * @listens NetworkAgent#handshake
     * @listens NetworkAgent#close
     * @param {PeerConnection} conn
     * @returns {void}
     * @private
     */
    _onConnection(conn) {
        // Reject connection if we are already connected to this peer address.
        // This can happen if the peer connects (inbound) while we are
        // initiating a (outbound) connection to it.
        if (conn.outbound && this._addresses.isConnected(conn.peerAddress)) {
            conn.close('duplicate connection (outbound, pre handshake)');
            return;
        }

        // Reject peer if we have reached max peer count.
        if (this.peerCount >= Network.PEER_COUNT_MAX) {
            if (conn.outbound) {
                this._addresses.disconnected(null, conn.peerAddress, false);
            }
            conn.close(`max peer count reached (${Network.PEER_COUNT_MAX})`);
            return;
        }

        // Connection accepted.
        const connType = conn.inbound ? 'inbound' : 'outbound';
        Log.d(Network, `Connection established (${connType}) #${conn.id} ${conn.netAddress || conn.peerAddress || '<pending>'}`);

        // Create peer channel.
        const channel = new PeerChannel(conn);
        channel.on('signal', msg => this._onSignal(channel, msg));
        channel.on('ban', reason => this._onBan(channel, reason));
        channel.on('fail', reason => this._onFail(channel, reason));

        // Create network agent.
        const agent = new NetworkAgent(this._blockchain, this._addresses, channel);
        agent.on('handshake', peer => this._onHandshake(peer, agent));
        agent.on('close', (peer, channel, closedByRemote) => this._onClose(peer, channel, closedByRemote));

        // Store the agent.
        this._agents.put(conn.id, agent);

        // Initiate handshake with the peer.
        agent.handshake();

        // Call _checkPeerCount() here in case the peer doesn't send us any (new)
        // addresses to keep on connecting.
        // Add a delay before calling it to allow RTC peer addresses to be sent to us.
        setTimeout(() => this._checkPeerCount(), Network.ADDRESS_UPDATE_DELAY);
    }


    /**
     * Handshake with this peer was successful.
     * @fires Network#peer-joined
     * @fires Network#peers-changed
     * @param {Peer} peer
     * @param {NetworkAgent} agent
     * @returns {void}
     * @private
     */
    _onHandshake(peer, agent) {
        // If the connector was able the determine the peer's netAddress, update the peer's advertised netAddress.
        if (peer.channel.netAddress) {
            // TODO What to do if it doesn't match the currently advertised one?
            if (peer.peerAddress.netAddress && !peer.peerAddress.netAddress.equals(peer.channel.netAddress)) {
                Log.w(Network, `Got different netAddress ${peer.channel.netAddress} for peer ${peer.peerAddress} `
                    + `- advertised was ${peer.peerAddress.netAddress}`);
            }

            // Only set the advertised netAddress if we have the public IP of the peer.
            // WebRTC connectors might return local IP addresses for peers on the same LAN.
            if (!peer.channel.netAddress.isPrivate()) {
                peer.peerAddress.netAddress = peer.channel.netAddress;
            }
        }
        // Otherwise, use the netAddress advertised for this peer if available.
        else if (peer.channel.peerAddress.netAddress) {
            peer.channel.netAddress = peer.channel.peerAddress.netAddress;
        }
        // Otherwise, we don't know the netAddress of this peer. Use a pseudo netAddress.
        else {
            peer.channel.netAddress = NetAddress.UNKNOWN;
        }

        // Close connection if we are already connected to this peer.
        if (this._addresses.isConnected(peer.peerAddress)) {
            agent.channel.close('duplicate connection (post handshake)');
            return;
        }

        // Close connection if this peer is banned.
        if (this._addresses.isBanned(peer.peerAddress)) {
            agent.channel.close('peer is banned');
            return;
        }

        // Close connection if we have too many connections to the peer's IP address.
        if (peer.netAddress && !peer.netAddress.isPseudo()) {
            const numConnections = this._agents.values().filter(
                agent => peer.netAddress.equals(agent.channel.netAddress));
            const maxConnections = peer.channel.connection.protocol === Protocol.WS ?
                Network.PEER_COUNT_PER_IP_WS_MAX : Network.PEER_COUNT_PER_IP_RTC_MAX;

            if (numConnections > maxConnections) {
                agent.channel.close(`connection limit per ip (${maxConnections}) reached`);
                return;
            }
        }

        // Recalculate the network adjusted offset
        this._updateTimeOffset();

        // Mark the peer's address as connected.
        this._addresses.connected(agent.channel, peer.peerAddress);

        // Tell others about the address that we just connected to.
        this._relayAddresses([peer.peerAddress]);

        // Let listeners know about this peer.
        this.fire('peer-joined', peer);

        // Let listeners know that the peers changed.
        this.fire('peers-changed');

        Log.d(Network, () => `[PEER-JOINED] ${peer.peerAddress} ${peer.netAddress} (version=${peer.version}, services=${peer.peerAddress.services}, headHash=${peer.headHash.toBase64()})`);
    }

    /**
     * Connection to this peer address failed.
     * @param {PeerAddress} peerAddress
     * @param {string|*} [reason]
     * @returns {void}
     * @private
     */
    _onError(peerAddress, reason) {
        Log.w(Network, `Connection to ${peerAddress} failed` + (reason ? ` - ${reason}` : ''));

        this._addresses.failure(peerAddress);

        this._checkPeerCount();
    }

    /**
     * This peer channel was closed.
     * @fires Network#peer-left
     * @fires Network#peers-changed
     * @param {Peer} peer
     * @param {PeerChannel} channel
     * @param {boolean} closedByRemote
     * @returns {void}
     * @private
     */
    _onClose(peer, channel, closedByRemote) {
        // Delete agent.
        this._agents.remove(channel.id);

        // Update total bytes sent/received.
        this._bytesSent += channel.connection.bytesSent;
        this._bytesReceived += channel.connection.bytesReceived;

        // peerAddress is undefined for incoming connections pre-handshake.
        if (channel.peerAddress) {
            // Check if the handshake with this peer has completed.
            if (this._addresses.isConnected(channel.peerAddress)) {
                // Mark peer as disconnected.
                this._addresses.disconnected(channel, channel.peerAddress, closedByRemote);

                // Tell listeners that this peer has gone away.
                this.fire('peer-left', peer);

                // Let listeners know that the peers changed.
                this.fire('peers-changed');

                const kbTransferred = ((channel.connection.bytesSent
                    + channel.connection.bytesReceived) / 1000).toFixed(2);
                Log.d(Network, `[PEER-LEFT] ${peer.peerAddress} ${peer.netAddress} `
                    + `(version=${peer.version}, headHash=${peer.headHash.toBase64()}, `
                    + `transferred=${kbTransferred} kB)`);
            } else {
                // Treat connections closed pre-handshake by remote as failed attempts.
                Log.w(Network, `Connection to ${channel.peerAddress} closed pre-handshake (by ${closedByRemote ? 'remote' : 'us'})`);
                if (closedByRemote) {
                    this._addresses.failure(channel.peerAddress);
                } else {
                    this._addresses.disconnected(null, channel.peerAddress, false);
                }
            }
        }

        // Recalculate the network adjusted offset
        this._updateTimeOffset();

        this._checkPeerCount();
    }

    /**
     * This peer channel was banned.
     * @param {PeerChannel} channel
     * @param {string|*} [reason]
     * @returns {void}
     * @private
     */
    _onBan(channel, reason) {
        // TODO If this is an inbound connection, the peerAddress might not be set yet.
        // Ban the netAddress in this case.
        // XXX We should probably always ban the netAddress as well.
        if (channel.peerAddress) {
            this._addresses.ban(channel.peerAddress);
        } else {
            // TODO ban netAddress
        }
    }

    /**
     * This peer channel had a network failure.
     * @param {PeerChannel} channel
     * @param {string|*} [reason]
     * @returns {void}
     * @private
     */
    _onFail(channel, reason) {
        if (channel.peerAddress) {
            this._addresses.failure(channel.peerAddress);
        }
    }

    /**
     * Updates the network time offset by calculating the median offset
     * from all our peers.
     * @returns {void}
     * @private
     */
    _updateTimeOffset() {
        const agents = this._agents.values();

        const offsets = [0]; // Add our own offset.
        agents.forEach(agent => {
            // The agent.peer property is null pre-handshake.
            if (agent.peer) {
                offsets.push(agent.peer.timeOffset);
            }
        });

        const offsetsLength = offsets.length;
        offsets.sort((a, b) => a - b);

        if ((offsetsLength % 2) === 0) {
            Time.timeOffset = Math.round((offsets[(offsetsLength / 2) - 1] + offsets[offsetsLength / 2]) / 2);
        } else {
            Time.timeOffset = offsets[(offsetsLength - 1) / 2];
        }
    }

    /* Signaling */

    /**
     * @param {PeerChannel} channel
     * @param {SignalMessage} msg
     * @returns {void}
     * @private
     */
    async _onSignal(channel, msg) {
        // Discard signals with invalid TTL.
        if (msg.ttl > Network.SIGNAL_TTL_INITIAL) {
            channel.ban('invalid signal ttl');
            return;
        }

        // Discard signals that have a payload, which is not properly signed.
        if (msg.hasPayload() && !(await msg.verifySignature())) {
            channel.ban('invalid signature');
            return;
        }

        // Can be undefined for non-rtc nodes.
        const mySignalId = NetworkConfig.myPeerAddress().signalId;

        // Discard signals from myself.
        if (msg.senderId.equals(mySignalId)) {
            Log.w(Network, `Received signal from myself to ${msg.recipientId} from ${channel.peerAddress} (myId: ${mySignalId})`);
            return;
        }

        // If the signal has the unroutable flag set and we previously forwarded a matching signal,
        // mark the route as unusable.
        if (msg.isUnroutable() && this._forwards.signalForwarded(/*senderId*/ msg.recipientId, /*recipientId*/ msg.senderId, /*nonce*/ msg.nonce)) {
            const senderAddr = this._addresses.getBySignalId(msg.senderId);
            this._addresses.unroutable(channel, senderAddr);
        }

        // If the signal is intended for us, pass it on to our WebRTC connector.
        if (msg.recipientId.equals(mySignalId)) {
            // If we sent out a signal that did not reach the recipient because of TTL
            // or it was unroutable, delete this route.
            if (this._rtcConnector.isValidSignal(msg) && (msg.isUnroutable() || msg.isTtlExceeded())) {
                const senderAddr = this._addresses.getBySignalId(msg.senderId);
                this._addresses.unroutable(channel, senderAddr);
            }
            this._rtcConnector.onSignal(channel, msg);
            return;
        }

        // Discard signals that have reached their TTL.
        if (msg.ttl <= 0) {
            Log.d(Network, `Discarding signal from ${msg.senderId} to ${msg.recipientId} - TTL reached`);
            // Send signal containing TTL_EXCEEDED flag back in reverse direction.
            if (msg.flags === 0) {
                channel.signal(/*senderId*/ msg.recipientId, /*recipientId*/ msg.senderId, msg.nonce, Network.SIGNAL_TTL_INITIAL, SignalMessage.Flags.TTL_EXCEEDED);
            }
            return;
        }

        // Otherwise, try to forward the signal to the intended recipient.
        const signalChannel = this._addresses.getChannelBySignalId(msg.recipientId);
        if (!signalChannel) {
            Log.d(Network, `Failed to forward signal from ${msg.senderId} to ${msg.recipientId} - no route found`);
            // If we don't know a route to the intended recipient, return signal to sender with unroutable flag set and payload removed.
            // Only do this if the signal is not already a unroutable response.
            if (msg.flags === 0) {
                channel.signal(/*senderId*/ msg.recipientId, /*recipientId*/ msg.senderId, msg.nonce, Network.SIGNAL_TTL_INITIAL, SignalMessage.Flags.UNROUTABLE);
            }
            return;
        }

        // Discard signal if our shortest route to the target is via the sending peer.
        // XXX Why does this happen?
        if (signalChannel.peerAddress.equals(channel.peerAddress)) {
            Log.w(Network, `Discarding signal from ${msg.senderId} to ${msg.recipientId} - shortest route via sending peer`);
            return;
        }

        // Decrement ttl and forward signal.
        signalChannel.signal(msg.senderId, msg.recipientId, msg.nonce, msg.ttl - 1, msg.flags, msg.payload, msg.senderPubKey, msg.signature);

        // We store forwarded messages if there are no special flags set.
        if (msg.flags === 0) {
            this._forwards.add(msg.senderId, msg.recipientId, msg.nonce);
        }

        // XXX This is very spammy!!!
        // Log.v(Network, `Forwarding signal (ttl=${msg.ttl}) from ${msg.senderId} `
        //     + `(received from ${channel.peerAddress}) to ${msg.recipientId} `
        //     + `(via ${signalChannel.peerAddress})`);
    }

    /** @type {number} */
    get peerCount() {
        return this._addresses.peerCount;
    }

    /** @type {number} */
    get peerCountWebSocket() {
        return this._addresses.peerCountWs;
    }

    /** @type {number} */
    get peerCountWebRtc() {
        return this._addresses.peerCountRtc;
    }

    /** @type {number} */
    get peerCountDumb() {
        return this._addresses.peerCountDumb;
    }

    /** @type {number} */
    get bytesSent() {
        return this._bytesSent
            + this._agents.values().reduce((n, agent) => n + agent.channel.connection.bytesSent, 0);
    }

    /** @type {number} */
    get bytesReceived() {
        return this._bytesReceived
            + this._agents.values().reduce((n, agent) => n + agent.channel.connection.bytesReceived, 0);
    }
}
Network.PEER_COUNT_DESIRED = 6;
Network.PEER_COUNT_RELAY = 4;
Network.CONNECTING_COUNT_MAX = 2;
Network.SIGNAL_TTL_INITIAL = 3;
Network.ADDRESS_UPDATE_DELAY = 1000; // 1 second
Network.CONNECT_BACKOFF_INITIAL = 1000; // 1 second
Network.CONNECT_BACKOFF_MAX = 5 * 60 * 1000; // 5 minutes
Class.register(Network);

class SignalStore {
    /**
     * @param {number} maxSize maximum number of entries
     */
    constructor(maxSize = 1000) {
        /** @type {number} */
        this._maxSize = maxSize;
        /** @type {Queue.<ForwardedSignal>} */
        this._queue = new Queue();
        /** @type {HashMap.<ForwardedSignal, number>} */
        this._store = new HashMap();
    }

    /** @type {number} */
    get length() {
        return this._queue.length;
    }

    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     */
    add(senderId, recipientId, nonce) {
        // If we already forwarded such a message, just update timestamp.
        if (this.contains(senderId, recipientId, nonce)) {
            const signal = new ForwardedSignal(senderId, recipientId, nonce);
            this._store.put(signal, Date.now());
            this._queue.remove(signal);
            this._queue.enqueue(signal);
            return;
        }

        // Delete oldest if needed.
        if (this.length >= this._maxSize) {
            const oldest = this._queue.dequeue();
            this._store.remove(oldest);
        }
        const signal = new ForwardedSignal(senderId, recipientId, nonce);
        this._queue.enqueue(signal);
        this._store.put(signal, Date.now());
    }

    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     * @return {boolean}
     */
    contains(senderId, recipientId, nonce) {
        const signal = new ForwardedSignal(senderId, recipientId, nonce);
        return this._store.contains(signal);
    }

    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     * @return {boolean}
     */
    signalForwarded(senderId, recipientId, nonce) {
        const signal = new ForwardedSignal(senderId, recipientId, nonce);
        const lastSeen = this._store.get(signal);
        if (!lastSeen) {
            return false;
        }
        const valid = lastSeen + ForwardedSignal.SIGNAL_MAX_AGE > Date.now();
        if (!valid) {
            // Because of the ordering, we know that everything after that is invalid too.
            const toDelete = this._queue.dequeueUntil(signal);
            for (const dSignal of toDelete) {
                this._store.remove(dSignal);
            }
        }
        return valid;
    }
}
SignalStore.SIGNAL_MAX_AGE = 10 /* seconds */;
Class.register(SignalStore);

class ForwardedSignal {
    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     */
    constructor(senderId, recipientId, nonce) {
        /** @type {SignalId} */
        this._senderId = senderId;
        /** @type {SignalId} */
        this._recipientId = recipientId;
        /** @type {number} */
        this._nonce = nonce;
    }

    /**
     * @param {ForwardedSignal} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof ForwardedSignal
            && this._senderId.equals(o._senderId)
            && this._recipientId.equals(o._recipientId)
            && this._nonce === o._nonce;
    }

    hashCode() {
        return this.toString();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `ForwardedSignal{senderId=${this._senderId}, recipientId=${this._recipientId}, nonce=${this._nonce}}`;
    }
}
Class.register(ForwardedSignal);

class NetUtils {
    /**
     * @param {string} ip
     * @return {boolean}
     */
    static isPrivateIP(ip) {
        if (NetUtils.isLocalIP(ip)) {
            return true;
        }

        if (NetUtils.isIPv4Address(ip)) {
            for (const subnet of NetUtils.IPv4_PRIVATE_NETWORK) {
                if (NetUtils.isIPv4inSubnet(ip, subnet)) {
                    return true;
                }
            }
            return false;
        }

        if (NetUtils.isIPv6Address(ip)) {
            const parts = ip.toLowerCase().split(':');
            const isEmbeddedIPv4 = NetUtils.isIPv4Address(parts[parts.length - 1]);
            if (isEmbeddedIPv4) {
                return NetUtils.isPrivateIP(parts[parts.length - 1]);
            }

            // Private subnet is fc00::/7.
            // So, we only check the first 7 bits of the address to be equal fc00.
            // The mask shifts by 16-7=9 bits (one part - mask size).
            if ((parseInt(parts[0], 16) & (-1<<9)) === 0xfc00) {
                return true;
            }

            // Link-local addresses are fe80::/10.
            // Shifting has to be carried out by 16-10=6 bits.
            if ((parseInt(parts[0], 16) & (-1<<6)) === 0xfe80) {
                return true;
            }

            // Does not seem to be a private IP.
            return false;
        }

        throw `Malformed IP address ${ip}`;
    }

    /**
     * @param {string} ip
     * @returns {boolean}
     */
    static isLocalIP(ip) {
        const saneIp = NetUtils._normalizeIP(ip);
        if (NetUtils.isIPv4Address(ip)) {
            return saneIp === '127.0.0.1';
        } else {
            return saneIp === '::1';
        }
    }

    /**
     * @param {string} ip
     * @param {string} subnet
     * @return {boolean}
     */
    static isIPv4inSubnet(ip, subnet) {
        let [subIp, mask] = subnet.split('/');
        mask = -1<<(32-parseInt(mask));
        return (NetUtils._IPv4toLong(ip) & mask) === NetUtils._IPv4toLong(subIp);
    }

    /**
     * @param {string} ip
     * @return {boolean}
     */
    static isIPv4Address(ip) {
        const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        return !!match && parseInt(match[1]) <= 255 && parseInt(match[2]) <= 255
            && parseInt(match[3]) <= 255 && parseInt(match[4]) <= 255;
    }

    /**
     * @param {string} ip
     * @return {boolean}
     */
    static isIPv6Address(ip) {
        const parts = ip.toLowerCase().split(':');
        // An IPv6 address consists of at most 8 parts and at least 3.
        if (parts.length > 8 || parts.length < 3) {
            return false;
        }

        const isEmbeddedIPv4 = NetUtils.isIPv4Address(parts[parts.length - 1]);

        let innerEmpty = false;
        for (let i = 0; i < parts.length; ++i) {
            // Check whether each part is valid.
            // Note: the last part may be a IPv4 address!
            // They can be embedded in the last part. Remember that they take 32bit.
            if (!(/^[a-f0-9]{0,4}$/.test(parts[i])
                    || (i === parts.length - 1
                        && isEmbeddedIPv4
                        && parts.length < 8))) {
                return false;
            }
            // Inside the parts, there has to be at most one empty part.
            if (parts[i].length === 0 && i > 0 && i < parts.length - 1) {
                if (innerEmpty) {
                    return false; // at least two empty parts
                }
                innerEmpty = true;
            }
        }

        // In the special case of embedded IPv4 addresses, everything but the last 48 bit must be 0.
        if (isEmbeddedIPv4) {
            // Exclude the last two parts.
            for (let i=0; i<parts.length-2; ++i) {
                if (!/^0{0,4}$/.test(parts[i])) {
                    return false;
                }
            }
        }

        // If the first part is empty, the second has to be empty as well (e.g., ::1).
        if (parts[0].length === 0) {
            return parts[1].length === 0;
        }

        // If the last part is empty, the second last has to be empty as well (e.g., 1::).
        if (parts[parts.length - 1].length === 0) {
            return parts[parts.length - 2].length === 0;
        }

        // If the length is less than 7 and an IPv4 address is embedded, there has to be an empty part.
        if (isEmbeddedIPv4 && parts.length < 7) {
            return innerEmpty;
        }

        // Otherwise if the length is less than 8, there has to be an empty part.
        if (parts.length < 8) {
            return innerEmpty;
        }

        return true;
    }

    /**
     * @param {string} ip
     * @return {string}
     */
    static sanitizeIP(ip) {
        const saneIp = NetUtils._normalizeIP(ip);
        // FIXME
        if (NetUtils.IP_BLACKLIST.indexOf(saneIp) >= 0) {
            throw `Malformed IP address ${ip}`;
        }
        // TODO reject IPv6 broadcast addresses
        return saneIp;
    }

    /**
     * @param {string} ip
     * @return {string}
     */
    static _normalizeIP(ip) {
        if (NetUtils.isIPv4Address(ip)) {
            // Re-create IPv4 address to strip possible leading zeros.
            // Embed into IPv6 format.
            const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            return `${parseInt(match[1])}.${parseInt(match[2])}.${parseInt(match[3])}.${parseInt(match[4])}`;
        }

        if (NetUtils.isIPv6Address(ip)) {
            // Shorten IPv6 address according to RFC 5952.

            // Only use lower-case letters.
            ip = ip.toLowerCase();

            // Split into parts.
            const parts = ip.split(':');

            // Return normalized IPv4 address if embedded.
            if (NetUtils.isIPv4Address(parts[parts.length - 1])) {
                return NetUtils._normalizeIP(parts[parts.length - 1]);
            }

            // If it is already shortened at one point, blow it up again.
            // It may be the case, that the current shortening is not as described in the RFC.
            const emptyIndex = parts.indexOf('');
            if (emptyIndex >= 0) {
                parts[emptyIndex] = '0';
                // Also check parts before and after emptyIndex and fill them up if necessary.
                if (emptyIndex > 0 && parts[emptyIndex-1] === '') {
                    parts[emptyIndex-1] = '0';
                }
                if (emptyIndex < parts.length - 1 && parts[emptyIndex+1] === '') {
                    parts[emptyIndex+1] = '0';
                }

                // Add 0s until we have a normal IPv6 length.
                const necessaryAddition = 8-parts.length;
                for (let i=0; i<necessaryAddition; ++i) {
                    parts.splice(emptyIndex, 0, '0');
                }
            }

            let maxZeroSeqStart = -1;
            let maxZeroSeqLength = 0;
            let curZeroSeqStart = -1;
            let curZeroSeqLength = 1;
            for (let i = 0; i < parts.length; ++i) {
                // Remove leading zeros from each part, but keep at least one number.
                parts[i] = parts[i].replace(/^0+([a-f0-9])/, '$1');

                // We look for the longest, leftmost consecutive sequence of zero parts.
                if (parts[i] === '0') {
                    // Freshly started sequence.
                    if (curZeroSeqStart < 0) {
                        curZeroSeqStart = i;
                    } else {
                        // Known sequence, so increment length.
                        curZeroSeqLength++;
                    }
                } else {
                    // A sequence just ended, check if it is of better length.
                    if (curZeroSeqStart >= 0 && curZeroSeqLength > maxZeroSeqLength) {
                        maxZeroSeqStart = curZeroSeqStart;
                        maxZeroSeqLength = curZeroSeqLength;
                        curZeroSeqStart = -1;
                        curZeroSeqLength = 1;
                    }
                }
            }

            if (curZeroSeqStart >= 0 && curZeroSeqLength > maxZeroSeqLength) {
                maxZeroSeqStart = curZeroSeqStart;
                maxZeroSeqLength = curZeroSeqLength;
            }

            // Remove consecutive zeros.
            if (maxZeroSeqStart >= 0 && maxZeroSeqLength > 1) {
                if (maxZeroSeqLength === parts.length) {
                    return '::';
                } else if (maxZeroSeqStart === 0 || maxZeroSeqStart + maxZeroSeqLength === parts.length) {
                    parts.splice(maxZeroSeqStart, maxZeroSeqLength, ':');
                } else {
                    parts.splice(maxZeroSeqStart, maxZeroSeqLength, '');
                }
            }

            return parts.join(':');
        }

        throw `Malformed IP address ${ip}`;
    }

    /**
     * @param {string} ip
     * @return {number}
     */
    static _IPv4toLong(ip) {
        const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        return (parseInt(match[1])<<24) + (parseInt(match[2])<<16) + (parseInt(match[3])<<8) + (parseInt(match[4]));
    }
}
NetUtils.IP_BLACKLIST = [
    '0.0.0.0',
    '255.255.255.255',
    '::',
];
NetUtils.IPv4_PRIVATE_NETWORK = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10', // link-local

    // Actually, the following one is only an approximation,
    // the first and the last /24 subnets in the range should be excluded.
    '169.254.0.0/16'
];
Class.register(NetUtils);

class PeerChannel extends Observable {
    /**
     * @listens PeerConnection#message
     * @param {PeerConnection} connection
     */
    constructor(connection) {
        super();
        this._conn = connection;
        this._conn.on('message', msg => this._onMessage(msg));

        // Forward specified events on the connection to listeners of this Observable.
        this.bubble(this._conn, 'close', 'error', 'ban');
    }

    /**
     * @param {Uint8Array} rawMsg
     * @private
     */
    _onMessage(rawMsg) {
        let msg;
        try {
            msg = MessageFactory.parse(rawMsg);
        } catch(e) {
            Log.w(PeerChannel, `Failed to parse message from ${this.peerAddress || this.netAddress}`, e.message);

            // Ban peer if it sends junk.
            // TODO We should probably be more lenient here. Bitcoin sends a
            // reject message if the message can't be decoded.
            // From the Bitcoin Reference:
            //  "Be careful of reject message feedback loops where two peers
            //   each don’t understand each other’s reject messages and so keep
            //   sending them back and forth forever."
            this.ban('junk received');
        }

        if (!msg) return;

        try {
            this.fire(PeerChannel.Event[msg.type], msg, this);
        } catch (e) {
            Log.w(PeerChannel, `Error while processing ${msg.type} message from ${this.peerAddress || this.netAddress}: ${e}`);
        }
    }

    /**
     * @param {Message} msg
     * @return {boolean}
     * @private
     */
    _send(msg) {
        return this._conn.send(msg.serialize());
    }

    /**
     * @param {string} [reason]
     */
    close(reason) {
        this._conn.close(reason);
    }

    /**
     * @param {string} [reason]
     */
    ban(reason) {
        this._conn.ban(reason);
    }

    /**
     * @param {string} [reason]
     */
    fail(reason) {
        this._conn.fail(reason);
    }

    /**
     * @param {PeerAddress} peerAddress
     * @param {Hash} headHash
     * @return {boolean}
     */
    version(peerAddress, headHash) {
        return this._send(new VersionMessage(Version.CODE, peerAddress, Block.GENESIS.HASH, headHash));
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @return {boolean}
     */
    inv(vectors) {
        return this._send(new InvMessage(vectors));
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @return {boolean}
     */
    notFound(vectors) {
        return this._send(new NotFoundMessage(vectors));
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @return {boolean}
     */
    getData(vectors) {
        return this._send(new GetDataMessage(vectors));
    }

    /**
     * @param {Array.<InvVector>} vectors
     * @return {boolean}
     */
    getHeader(vectors) {
        return this._send(new GetHeaderMessage(vectors));
    }

    /**
     * @param {Block} block
     * @return {boolean}
     */
    block(block) {
        return this._send(new BlockMessage(block));
    }

    /**
     * @param {BlockHeader} header
     * @return {boolean}
     */
    header(header) {
        return this._send(new HeaderMessage(header));
    }

    /**
     * @param {Transaction} transaction
     * @param {?AccountsProof} [accountsProof]
     * @return {boolean}
     */
    tx(transaction, accountsProof) {
        return this._send(new TxMessage(transaction, accountsProof));
    }

    /**
     * @param {Array.<Hash>} locators
     * @param {number} maxInvSize
     * @param {boolean} [ascending]
     * @return {boolean}
     */
    getBlocks(locators, maxInvSize=BaseInventoryMessage.VECTORS_MAX_COUNT, ascending=true) {
        return this._send(new GetBlocksMessage(locators, maxInvSize, ascending ? GetBlocksMessage.Direction.FORWARD : GetBlocksMessage.Direction.BACKWARD));
    }

    /**
     * @return {boolean}
     */
    mempool() {
        return this._send(new MempoolMessage());
    }

    /**
     * @param {Message.Type} messageType
     * @param {RejectMessage.Code} code
     * @param {string} reason
     * @param {Uint8Array} extraData
     * @return {boolean}
     */
    reject(messageType, code, reason, extraData) {
        return this._send(new RejectMessage(messageType, code, reason, extraData));
    }

    /**
     * @param {Subscription} subscription
     * @returns {boolean}
     */
    subscribe(subscription) {
        return this._send(new SubscribeMessage(subscription));
    }

    /**
     * @param {Array.<PeerAddress>} addresses
     * @return {boolean}
     */
    addr(addresses) {
        return this._send(new AddrMessage(addresses));
    }

    /**
     * @param {number} protocolMask
     * @param {number} serviceMask
     * @return {boolean}
     */
    getAddr(protocolMask, serviceMask) {
        return this._send(new GetAddrMessage(protocolMask, serviceMask));
    }

    /**
     * @param {number} nonce
     * @return {boolean}
     */
    ping(nonce) {
        return this._send(new PingMessage(nonce));
    }

    /**
     * @param {number} nonce
     * @return {boolean}
     */
    pong(nonce) {
        return this._send(new PongMessage(nonce));
    }

    /**
     * @param {SignalId} senderId
     * @param {SignalId} recipientId
     * @param {number} nonce
     * @param {number} ttl
     * @param {SignalMessage.Flags|number} flags
     * @param {Uint8Array} [payload]
     * @param {PublicKey} [senderPubKey]
     * @param {Signature} [signature]
     * @return {boolean}
     */
    signal(senderId, recipientId, nonce, ttl, flags, payload, senderPubKey, signature) {
        return this._send(new SignalMessage(senderId, recipientId, nonce, ttl, flags, payload, senderPubKey, signature));
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @return {boolean}
     */
    getAccountsProof(blockHash, addresses) {
        return this._send(new GetAccountsProofMessage(blockHash, addresses));
    }

    /**
     * @param {Hash} blockHash
     * @param {AccountsProof} proof
     * @return {boolean}
     */
    accountsProof(blockHash, proof) {
        return this._send(new AccountsProofMessage(blockHash, proof));
    }

    /**
     * @return {boolean}
     */
    getChainProof() {
        return this._send(new GetChainProofMessage());
    }

    /**
     * @param {ChainProof} proof
     * @return {boolean}
     */
    chainProof(proof) {
        return this._send(new ChainProofMessage(proof));
    }

    /**
     * @param {Hash} blockHash
     * @param {string} startPrefix
     * @return {boolean}
     */
    getAccountsTreeChunk(blockHash, startPrefix) {
        return this._send(new GetAccountsTreeChunkMessage(blockHash, startPrefix));
    }

    /**
     * @param {Hash} blockHash
     * @param {AccountsTreeChunk} chunk
     * @return {boolean}
     */
    accountsTreeChunk(blockHash, chunk) {
        return this._send(new AccountsTreeChunkMessage(blockHash, chunk));
    }

    /**
     * @returns {boolean}
     */
    rejectAccounts() {
        return this._send(new AccountsRejectedMessage());
    }

    /**
     * @param {Hash} blockHash
     * @param {Array.<Address>} addresses
     * @return {boolean}
     */
    getTransactionsProof(blockHash, addresses) {
        return this._send(new GetTransactionsProofMessage(blockHash, addresses));
    }

    /**
     * @param {Hash} blockHash
     * @param {TransactionsProof} proof
     * @return {boolean}
     */
    transactionsProof(blockHash, proof) {
        return this._send(new TransactionsProofMessage(blockHash, proof));
    }

    /**
     * @param {PeerChannel} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof PeerChannel
            && this._conn.equals(o.connection);
    }

    hashCode() {
        return this._conn.hashCode();
    }

    /**
     * @return {string}
     */
    toString() {
        return `PeerChannel{conn=${this._conn}}`;
    }

    /** @type {PeerConnection} */
    get connection() {
        return this._conn;
    }

    /** @type {number} */
    get id() {
        return this._conn.id;
    }

    /** @type {number} */
    get protocol() {
        return this._conn.protocol;
    }

    /** @type {PeerAddress} */
    get peerAddress() {
        return this._conn.peerAddress;
    }

    /** @type {PeerAddress} */
    set peerAddress(value) {
        this._conn.peerAddress = value;
    }

    /** @type {NetAddress} */
    get netAddress() {
        return this._conn.netAddress;
    }

    /** @type {NetAddress} */
    set netAddress(value) {
        this._conn.netAddress = value;
    }

    /** @type {boolean} */
    get closed() {
        return this._conn.closed;
    }
}
Class.register(PeerChannel);

PeerChannel.Event = {};
PeerChannel.Event[Message.Type.VERSION] = 'version';
PeerChannel.Event[Message.Type.INV] = 'inv';
PeerChannel.Event[Message.Type.GET_DATA] = 'get-data';
PeerChannel.Event[Message.Type.GET_HEADER] = 'get-header';
PeerChannel.Event[Message.Type.NOT_FOUND] = 'not-found';
PeerChannel.Event[Message.Type.GET_BLOCKS] = 'get-blocks';
PeerChannel.Event[Message.Type.BLOCK] = 'block';
PeerChannel.Event[Message.Type.HEADER] = 'header';
PeerChannel.Event[Message.Type.TX] = 'tx';
PeerChannel.Event[Message.Type.MEMPOOL] = 'mempool';
PeerChannel.Event[Message.Type.REJECT] = 'reject';
PeerChannel.Event[Message.Type.SUBSCRIBE] = 'subscribe';
PeerChannel.Event[Message.Type.ADDR] = 'addr';
PeerChannel.Event[Message.Type.GET_ADDR] = 'get-addr';
PeerChannel.Event[Message.Type.PING] = 'ping';
PeerChannel.Event[Message.Type.PONG] = 'pong';
PeerChannel.Event[Message.Type.SIGNAL] = 'signal';
PeerChannel.Event[Message.Type.GET_CHAIN_PROOF] = 'get-chain-proof';
PeerChannel.Event[Message.Type.CHAIN_PROOF] = 'chain-proof';
PeerChannel.Event[Message.Type.GET_ACCOUNTS_PROOF] = 'get-accounts-proof';
PeerChannel.Event[Message.Type.ACCOUNTS_PROOF] = 'accounts-proof';
PeerChannel.Event[Message.Type.GET_ACCOUNTS_TREE_CHUNK] = 'get-accounts-tree-chunk';
PeerChannel.Event[Message.Type.ACCOUNTS_TREE_CHUNK] = 'accounts-tree-chunk';
PeerChannel.Event[Message.Type.ACCOUNTS_REJECTED] = 'accounts-rejected';
PeerChannel.Event[Message.Type.GET_TRANSACTIONS_PROOF] = 'get-transactions-proof';
PeerChannel.Event[Message.Type.TRANSACTIONS_PROOF] = 'transactions-proof';

// TODO: DO NOT try to use different native channel objects from one entity, use abstraction layer!
class PeerConnection extends Observable {
    /**
     * @param {object} nativeChannel
     * @param {number} protocol
     * @param {NetAddress} netAddress
     * @param {PeerAddress} peerAddress
     */
    constructor(nativeChannel, protocol, netAddress, peerAddress) {
        super();
        this._channel = nativeChannel;

        /** @type {number} */
        this._protocol = protocol;
        /** @type {NetAddress} */
        this._netAddress = netAddress;
        /** @type {PeerAddress} */
        this._peerAddress = peerAddress;

        /** @type {number} */
        this._bytesSent = 0;
        /** @type {number} */
        this._bytesReceived = 0;

        /** @type {boolean} */
        this._inbound = !peerAddress;
        /** @type {boolean} */
        this._closedByUs = false;
        /** @type {boolean} */
        this._closed = false;

        // Unique id for this connection.
        /** @type {number} */
        this._id = PeerConnection._instanceCount++;

        if (this._channel.on) {
            this._channel.on('message', msg => this._onMessage(msg.data || msg));
            this._channel.on('close', () => this._onClose());
            this._channel.on('error', e => this.fire('error', e, this));
        } else {
            this._channel.onmessage = msg => this._onMessage(msg.data || msg);
            this._channel.onclose = () => this._onClose();
            this._channel.onerror = e => this.fire('error', e, this);
        }
    }

    _onMessage(msg) {
        // Don't emit messages if this channel is closed.
        if (this._closed) {
            return;
        }

        // XXX Cleanup!
        if (!PlatformUtils.isBrowser() || !(msg instanceof Blob)) {
            this._bytesReceived += msg.byteLength || msg.length;
            this.fire('message', msg, this);
        } else {
            Log.e(PeerConnection, `Converting blob to ArrayBuffer on ${this._channel}`);
            // Browser only
            // TODO FileReader is slow and this is ugly anyways. Improve!
            const reader = new FileReader();
            reader.onloadend = () => this._onMessage(reader.result);
            reader.readAsArrayBuffer(msg);
        }
    }

    _onClose() {
        // Don't fire close event again when already closed.
        if (this._closed) {
            return;
        }

        // Mark this connection as closed.
        this._closed = true;

        // Tell listeners that this connection has closed.
        this.fire('close', !this._closedByUs, this);
    }

    _close() {
        this._closedByUs = true;

        // Don't wait for the native close event to fire.
        this._onClose();

        // Close the native channel.
        this._channel.close();
    }

    /**
     * @return {boolean}
     * @private
     */
    _isChannelOpen() {
        return this._channel.readyState === WebSocket.OPEN
            || this._channel.readyState === 'open';
    }

    /**
     * @return {boolean}
     * @private
     */
    _isChannelClosing() {
        return this._channel.readyState === WebSocket.CLOSING
            || this._channel.readyState === 'closing';
    }

    /**
     * @return {boolean}
     * @private
     */
    _isChannelClosed() {
        return this._channel.readyState === WebSocket.CLOSED
            || this._channel.readyState === 'closed';
    }

    /**
     * @param {Uint8Array} msg
     * @return {boolean}
     */
    send(msg) {
        const logAddress = this._peerAddress || this._netAddress;
        if (this._closed) {
            return false;
        }

        // Fire close event (early) if channel is closing/closed.
        if (this._isChannelClosing() || this._isChannelClosed()) {
            Log.w(PeerConnection, `Not sending data to ${logAddress} - channel closing/closed (${this._channel.readyState})`);
            this._onClose();
            return false;
        }

        // Don't attempt to send if channel is not (yet) open.
        if (!this._isChannelOpen()) {
            Log.w(PeerConnection, `Not sending data to ${logAddress} - channel not open (${this._channel.readyState})`);
            return false;
        }

        try {
            this._channel.send(msg);
            this._bytesSent += msg.byteLength || msg.length;
            return true;
        } catch (e) {
            Log.e(PeerConnection, `Failed to send data to ${logAddress}: ${e.message || e}`);
            return false;
        }
    }

    /**
     * @param {string} [reason]
     */
    close(reason) {
        const connType = this._inbound ? 'inbound' : 'outbound';
        Log.d(PeerConnection, `Closing ${connType} connection #${this._id} ${this._peerAddress || this._netAddress}` + (reason ? ` - ${reason}` : ''));
        this._close();
    }

    /**
     * @param {string} [reason]
     */
    ban(reason) {
        Log.w(PeerConnection, `Banning peer ${this._peerAddress || this._netAddress}` + (reason ? ` - ${reason}` : ''));
        this._close();
        this.fire('ban', reason, this);
    }

    /**
     * @param {string} [reason]
     */
    fail(reason) {
        Log.w(PeerConnection, `Network failure on peer ${this._peerAddress || this._netAddress}` + (reason ? ` - ${reason}` : ''));
        this._close();
        this.fire('fail', reason, this);
    }

    /**
     * @param {PeerConnection} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof PeerConnection
            && this._id === o.id;
    }

    hashCode() {
        return this._id;
    }

    /**
     * @return {string}
     */
    toString() {
        return `PeerConnection{id=${this._id}, protocol=${this._protocol}, peerAddress=${this._peerAddress}, netAddress=${this._netAddress}}`;
    }

    /** @type {number} */
    get id() {
        return this._id;
    }

    /** @type {number} */
    get protocol() {
        return this._protocol;
    }

    /** @type {PeerAddress} */
    get peerAddress() {
        return this._peerAddress;
    }

    /** @type {PeerAddress} */
    set peerAddress(value) {
        this._peerAddress = value;
    }

    /** @type {NetAddress} */
    get netAddress() {
        return this._netAddress;
    }

    /** @type {NetAddress} */
    set netAddress(value) {
        this._netAddress = value;
    }

    /** @type {number} */
    get bytesSent() {
        return this._bytesSent;
    }

    /** @type {number} */
    get bytesReceived() {
        return this._bytesReceived;
    }

    /** @type {boolean} */
    get inbound() {
        return this._inbound;
    }

    /** @type {boolean} */
    get outbound() {
        return !this._inbound;
    }

    /** @type {boolean} */
    get closed() {
        return this._closed;
    }
}
// Used to generate unique PeerConnection ids.
PeerConnection._instanceCount = 0;
Class.register(PeerConnection);

class Peer {
    /**
     * @param {PeerChannel} channel
     * @param {number} version
     * @param {Hash} headHash
     * @param {number} timeOffset
     */
    constructor(channel, version, headHash, timeOffset) {
        /** @type {PeerChannel} */
        this._channel = channel;
        /** @type {number} */
        this._version = version;
        /** @type {Hash} */
        this._headHash = headHash;
        /**
         * Offset between the peer's time and our local time.
         * @type {number}
         */
        this._timeOffset = timeOffset;
    }

    /** @type {PeerChannel} */
    get channel() {
        return this._channel;
    }

    /** @type {number} */
    get version() {
        return this._version;
    }

    /** @type {Hash} */
    get headHash() {
        return this._headHash;
    }

    /** @type {number} */
    get timeOffset() {
        return this._timeOffset;
    }

    /** @type {number} */
    get id() {
        return this._channel.id;
    }

    /** @type {PeerAddress} */
    get peerAddress() {
        return this._channel.peerAddress;
    }

    /** @type {NetAddress} */
    get netAddress() {
        return this._channel.netAddress;
    }

    /**
     * @param {Peer} o
     * @returns {boolean}
     */
    equals(o) {
        return o instanceof Peer
            && this._channel.equals(o.channel);
    }

    hashCode() {
        return this._channel.hashCode();
    }

    /**
     * @returns {string}
     */
    toString() {
        return `Peer{version=${this._version}, headHash=${this._headHash}, `
            + `peerAddress=${this.peerAddress}, netAddress=${this.netAddress}}`;
    }
}
Class.register(Peer);

class Miner extends Observable {
    /**
     * @param {IBlockchain} blockchain
     * @param {Mempool} mempool
     * @param {Address} minerAddress
     * @param {Uint8Array} extraData
     *
     * @listens Mempool#transaction-added
     * @listens Mempool#transaction-ready
     */
    constructor(blockchain, mempool, minerAddress, extraData = new Uint8Array(0)) {
        super();
        /** @type {IBlockchain} */
        this._blockchain = blockchain;
        /** @type {Mempool} */
        this._mempool = mempool;
        /** @type {Address} */
        this._address = minerAddress;
        /** @type {Uint8Array} */
        this._extraData = extraData;

        /**
         * Number of hashes computed since the last hashrate update.
         * @type {number}
         * @private
         */
        this._hashCount = 0;

        /**
         * Timestamp of the last hashrate update.
         * @type {number}
         * @private
         */
        this._lastHashrate = 0;

        /**
         * Hashrate computation interval handle.
         * @private
         */
        this._hashrateWorker = null;

        /**
         * The current hashrate of this miner.
         * @type {number}
         * @private
         */
        this._hashrate = 0;

        /**
         * The last hash counts used in the moving average.
         * @type {Array.<number>}
         * @private
         */
        this._lastHashCounts = [];

        /**
         * The total hashCount used in the current moving average.
         * @type {number}
         * @private
         */
        this._totalHashCount = 0;

        /**
         * The time elapsed for the last measurements used in the moving average.
         * @type {Array.<number>}
         * @private
         */
        this._lastElapsed = [];

        /**
         * The total time elapsed used in the current moving average.
         * @type {number}
         * @private
         */
        this._totalElapsed = 0;

        /** @type {MinerWorkerPool} */
        this._workerPool = new MinerWorkerPool();

        if (typeof navigator === 'object' && navigator.hardwareConcurrency) {
            this.threads = Math.ceil(navigator.hardwareConcurrency / 2);
        } else if (PlatformUtils.isNodeJs()) {
            const cores = require('os').cpus().length;
            this.threads = Math.ceil(cores / 2);
            if (cores === 1) this.throttleAfter = 2;
        } else {
            this.threads = 1;
        }
        this._workerPool.on('share', (obj) => this._onWorkerShare(obj));
        this._workerPool.on('no-share', (obj) => this._onWorkerShare(obj));

        /**
         * Flag indicating that the mempool has changed since we started mining the current block.
         * @type {boolean}
         * @private
         */
        this._mempoolChanged = false;

        /** @type {boolean} */
        this._restarting = false;

        /** @type {number} */
        this._lastRestart = 0;

        /** @type {boolean} */
        this._submittingBlock = false;

        // Listen to changes in the mempool which evicts invalid transactions
        // after every blockchain head change and then fires 'transactions-ready'
        // when the eviction process finishes. Restart work on the next block
        // with fresh transactions when this fires.
        this._mempool.on('transactions-ready', () => this._startWork());

        // Immediately start processing transactions when they come in.
        this._mempool.on('transaction-added', () => this._mempoolChanged = true);
    }

    startWork() {
        if (this.working) {
            return;
        }

        // Initialize hashrate computation.
        this._hashCount = 0;
        this._lastElapsed = [];
        this._lastHashCounts = [];
        this._totalHashCount = 0;
        this._totalElapsed = 0;
        this._lastHashrate = Date.now();
        this._hashrateWorker = setInterval(() => this._updateHashrate(), 1000);

        // Tell listeners that we've started working.
        this.fire('start', this);

        // Kick off the mining process.
        this._startWork().catch(Miner._log);
    }

    async _startWork() {
        // XXX Needed as long as we cannot unregister from transactions-ready events.
        if (!this.working || this._restarting) {
            return;
        }
        try {
            this._lastRestart = Date.now();
            this._restarting = true;
            this._mempoolChanged = false;

            // Construct next block.
            const block = await this.getNextBlock();

            Log.i(Miner, `Starting work on ${block.header}, transactionCount=${block.transactionCount}, hashrate=${this._hashrate} H/s`);

            this._workerPool.startMiningOnBlock(block).catch(Miner._log);
        } finally {
            this._restarting = false;
        }
    }

    /**
     * @param {{hash: Hash, nonce: number, block: Block}} obj
     * @private
     */
    async _onWorkerShare(obj) {
        this._hashCount += this._workerPool.noncesPerRun;
        if (obj.block && obj.block.prevHash.equals(this._blockchain.headHash)) {
            Log.d(Miner, () => `Received share: ${obj.nonce} / ${obj.hash.toHex()}`);
            if (BlockUtils.isProofOfWork(obj.hash, obj.block.target) && !this._submittingBlock) {
                obj.block.header.nonce = obj.nonce;
                this._submittingBlock = true;
                if (obj.block.header.verifyProofOfWork()) {
                    // Tell listeners that we've mined a block.
                    this.fire('block-mined', obj.block, this);

                    // Push block into blockchain.
                    if ((await this._blockchain.pushBlock(obj.block)) < 0) {
                        this._submittingBlock = false;
                        this._startWork().catch(Miner._log);
                        return;
                    } else {
                        this._submittingBlock = false;
                    }
                } else {
                    Log.d(Miner, `Ignoring invalid share: ${await obj.block.header.pow()}`);
                }
            }
        }
        if (this._mempoolChanged && this._lastRestart + Miner.MIN_TIME_ON_BLOCK < Date.now()) {
            this._startWork().catch(Miner._log);
        }
    }

    /**
     * @param {Error|*} e
     * @private
     */
    static _log(e) {
        Log.w(Miner, e.message || e);
    }

    /**
     * @return {Promise.<Block>}
     * @private
     */
    async getNextBlock() {
        const nextTarget = await this._blockchain.getNextTarget();
        const interlink = await this._getNextInterlink(nextTarget);
        const body = this._getNextBody(interlink.serializedSize);
        const header = await this._getNextHeader(nextTarget, interlink, body);
        return new Block(header, interlink, body);
    }

    /**
     * @param {number} nextTarget
     * @param {BlockInterlink} interlink
     * @param {BlockBody} body
     * @return {Promise.<BlockHeader>}
     * @private
     */
    async _getNextHeader(nextTarget, interlink, body) {
        const prevHash = this._blockchain.headHash;
        const interlinkHash = await interlink.hash();
        const height = this._blockchain.height + 1;

        // Compute next accountsHash.
        const accounts = await this._blockchain.accounts.transaction();
        let accountsHash;
        try {
            await accounts.commitBlockBody(body, height);
            accountsHash = await accounts.hash();
            await accounts.abort();
        } catch (e) {
            await accounts.abort();
            throw new Error(`Invalid block body: ${e.message}`);
        }

        const bodyHash = await body.hash();
        const timestamp = this._getNextTimestamp();
        const nBits = BlockUtils.targetToCompact(nextTarget);
        const nonce = Math.round(Math.random() * 100000);
        return new BlockHeader(prevHash, interlinkHash, bodyHash, accountsHash, nBits, height, timestamp, nonce);
    }

    /**
     * @param {number} nextTarget
     * @returns {Promise.<BlockInterlink>}
     * @private
     */
    _getNextInterlink(nextTarget) {
        return this._blockchain.head.getNextInterlink(nextTarget);
    }

    /**
     * @param {number} interlinkSize
     * @return {BlockBody}
     * @private
     */
    _getNextBody(interlinkSize) {
        const maxSize = Policy.BLOCK_SIZE_MAX
            - BlockHeader.SERIALIZED_SIZE
            - interlinkSize
            - BlockBody.getMetadataSize(this._extraData);
        const transactions = this._mempool.getTransactionsForBlock(maxSize);
        return new BlockBody(this._address, transactions, this._extraData);
    }

    /**
     * @return {number}
     * @private
     */
    _getNextTimestamp() {
        const now = Math.floor(Time.now() / 1000);
        return Math.max(now, this._blockchain.head.timestamp + 1);
    }

    /**
     * @fires Miner#stop
     */
    stopWork() {
        // TODO unregister from blockchain head-changed events.
        if (!this.working) {
            return;
        }

        clearInterval(this._hashrateWorker);
        this._hashrateWorker = null;
        this._hashrate = 0;
        this._lastElapsed = [];
        this._lastHashCounts = [];
        this._totalHashCount = 0;
        this._totalElapsed = 0;

        // Tell listeners that we've stopped working.
        this._workerPool.stop();
        this.fire('stop', this);

        Log.i(Miner, 'Stopped work');
    }

    /**
     * @fires Miner#hashrate-changed
     * @private
     */
    _updateHashrate() {
        const elapsed = (Date.now() - this._lastHashrate) / 1000;
        const hashCount = this._hashCount;
        // Enable next measurement.
        this._hashCount = 0;
        this._lastHashrate = Date.now();

        // Update stored information on moving average.
        this._lastElapsed.push(elapsed);
        this._lastHashCounts.push(hashCount);
        this._totalElapsed += elapsed;
        this._totalHashCount += hashCount;

        if (this._lastElapsed.length > Miner.MOVING_AVERAGE_MAX_SIZE) {
            const oldestElapsed = this._lastElapsed.shift();
            const oldestHashCount = this._lastHashCounts.shift();
            this._totalElapsed -= oldestElapsed;
            this._totalHashCount -= oldestHashCount;
        }

        this._hashrate = Math.round(this._totalHashCount / this._totalElapsed);

        // Tell listeners about our new hashrate.
        this.fire('hashrate-changed', this._hashrate, this);
    }

    /** @type {Address} */
    get address() {
        return this._address;
    }

    /** @type {boolean} */
    get working() {
        return !!this._hashrateWorker;
    }

    /** @type {number} */
    get hashrate() {
        return this._hashrate;
    }

    /** @type {number} */
    get threads() {
        return this._workerPool.poolSize;
    }

    /**
     * @param {number} threads
     */
    set threads(threads) {
        this._workerPool.poolSize = threads;
    }

    /** @type {number} */
    get throttleWait() {
        return this._workerPool.cycleWait;
    }

    /**
     * @param {number} throttleWait
     */
    set throttleWait(throttleWait) {
        this._workerPool.cycleWait = throttleWait;
    }

    /** @type {number} */
    get throttleAfter() {
        return this._workerPool.runsPerCycle;
    }

    /**
     * @param {number} throttleAfter
     */
    set throttleAfter(throttleAfter) {
        this._workerPool.runsPerCycle = throttleAfter;
    }
}

Miner.MIN_TIME_ON_BLOCK = 10000;
Miner.MOVING_AVERAGE_MAX_SIZE = 10;
Class.register(Miner);

class WalletStore {
    /**
     * @returns {Promise.<WalletStore>}
     */
    constructor() {
        this._jdb = new JDB.JungleDB('wallet', WalletStore.VERSION);
        return this._init();
    }

    /**
     * @returns {Promise.<WalletStore>}
     * @private
     */
    async _init() {
        // Initialize object stores.
        this._jdb.createObjectStore(WalletStore.KEY_DATABASE, new WalletStoreCodec());

        // Establish connection to database.
        await this._jdb.connect();

        return this;
    }

    /**
     * @param {string} key
     * @returns {Promise.<KeyPair>}
     */
    get(key) {
        const store = this._jdb.getObjectStore(WalletStore.KEY_DATABASE);
        return store.get(key);
    }

    /**
     * @param {string} key
     * @param {KeyPair} keyPair
     * @returns {Promise}
     */
    put(key, keyPair) {
        const store = this._jdb.getObjectStore(WalletStore.KEY_DATABASE);
        return store.put(key, keyPair);
    }

    close() {
        return this._jdb.close();
    }
}
WalletStore._instance = null;
WalletStore.VERSION = 1;
WalletStore.KEY_DATABASE = 'keys';
Class.register(WalletStore);

/**
 * @implements {ICodec}
 */
class WalletStoreCodec {
    /**
     * @param {*} obj The object to encode before storing it.
     * @returns {*} Encoded object.
     */
    encode(obj) {
        return obj.serialize();
    }

    /**
     * @param {*} buf The object to decode.
     * @param {string} key The object's primary key.
     * @returns {*} Decoded object.
     */
    decode(buf, key) {
        return KeyPair.unserialize(new SerialBuffer(buf));
    }

    /**
     * @type {string}
     */
    get valueEncoding() {
        return 'binary';
    }
}

// TODO V2: Store private key encrypted
class Wallet {
    /**
     * Create a Wallet with persistent storage backend.
     * @returns {Promise.<Wallet>} A Wallet object. If the persisted storage already stored a Wallet before, this will be reused.
     */
    static async getPersistent() {
        await Crypto.prepareSyncCryptoWorker();
        const db = await new WalletStore();
        let keys = await db.get('keys');
        if (!keys) {
            keys = await KeyPair.generate();
            await db.put('keys', keys);
        }
        await db.close();
        return new Wallet(keys);
    }

    /**
     * Create a Wallet that will lose its data after this session.
     * @returns {Promise.<Wallet>} Newly created Wallet.
     */
    static async createVolatile() {
        await Crypto.prepareSyncCryptoWorker();
        return new Wallet(await KeyPair.generate());
    }

    /**
     * @param {string} hexBuf
     * @return {Wallet}
     */
    static load(hexBuf) {
        if (!hexBuf || !StringUtils.isHexBytes(hexBuf) || hexBuf.length === 0) {
            throw new Error('Invalid wallet seed');
        }

        return new Wallet(KeyPair.fromHex(hexBuf));
    }

    /**
     * Create a new Wallet object.
     * @param {KeyPair} keyPair KeyPair owning this Wallet.
     * @returns {Wallet} A newly generated Wallet.
     */
    constructor(keyPair) {
        /** @type {KeyPair} */
        this._keyPair = keyPair;
        /** @type {Address} */
        this._address = undefined;
        this._address = this._keyPair.publicKey.toAddressSync();
    }

    /**
     * Create a Transaction that is signed by the owner of this Wallet.
     * @param {Address} recipient Address of the transaction receiver
     * @param {number} value Number of Satoshis to send.
     * @param {number} fee Number of Satoshis to donate to the Miner.
     * @param {number} nonce The nonce representing the current balance of the sender.
     * @returns {Promise.<Transaction>} A prepared and signed Transaction object. This still has to be sent to the network.
     */
    createTransaction(recipient, value, fee, nonce) {
        const transaction = new BasicTransaction(this._keyPair.publicKey, recipient, value, fee, nonce);
        return this._signTransaction(transaction);
    }

    /**
     * @param {BasicTransaction} transaction
     * @returns {Promise.<Transaction>}
     * @private
     */
    async _signTransaction(transaction) {
        transaction.signature = await Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
        return transaction;
    }

    /**
     * The address of the Wallet owner.
     * @type {Address}
     */
    get address() {
        return this._address;
    }

    /**
     * The public key of the Wallet owner
     * @type {PublicKey}
     */
    get publicKey() {
        return this._keyPair.publicKey;
    }

    /** @type {KeyPair} */
    get keyPair() {
        return this._keyPair;
    }

    /** 
     * @returns {string}
     */
    dump() {
        return this._keyPair.toHex();
    }

    /**
     * @returns {Promise}
     */
    async persist() {
        const db = await new WalletStore();
        await db.put('keys', this._keyPair);
        await db.close();
    }

    /** @type {boolean} */
    get isLocked() {
        return this.keyPair.isLocked;
    }

    /**
     * @param {Uint8Array|string} key
     * @returns {Promise.<void>}
     */
    async lock(key) {
        if (typeof key === 'string') key = BufferUtils.fromAscii(key);
        return this.keyPair.lock(key);
    }

    relock() {
        this.keyPair.relock();
    }

    /**
     * @param {Uint8Array|string} key
     * @returns {Promise.<void>}
     */
    unlock(key) {
        if (typeof key === 'string') key = BufferUtils.fromAscii(key);
        return this.keyPair.unlock(key);
    }
}

Class.register(Wallet);

// TODO V2: Store private key encrypted
class MultiSigWallet {
    /**
     * Create a new MultiSigWallet object.
     * @param {KeyPair} keyPair KeyPair owning this Wallet.
     * @param {number} minSignatures Number of signatures required.
     * @param {Array.<PublicKey>} publicKeys A list of all owners' public keys.
     * @returns {Promise.<MultiSigWallet>} A newly generated MultiSigWallet.
     */
    static async fromPublicKeys(keyPair, minSignatures, publicKeys) {
        const combinations = [...ArrayUtils.k_combinations(publicKeys, minSignatures)];
        const multiSigKeys = await Promise.all(combinations.map(arr => PublicKey.sum(arr)));
        return new MultiSigWallet(keyPair, minSignatures, multiSigKeys);
    }

    /**
     * Create a new MultiSigWallet object.
     * @param {KeyPair} keyPair KeyPair owning this Wallet.
     * @param {number} minSignatures Number of signatures required.
     * @param {Array.<PublicKey>} publicKeys A list of all aggregated public keys.
     * @returns {Promise.<MultiSigWallet>} A newly generated MultiSigWallet.
     */
    constructor(keyPair, minSignatures, publicKeys) {
        /** @type {KeyPair} */
        this._keyPair = keyPair;
        /** @type {number} minSignatures */
        this._minSignatures = minSignatures;
        /** @type {Array.<PublicKey>} publicKeys */
        this._publicKeys = publicKeys;
        this._publicKeys.sort((a, b) => a.compare(b));
        /** @type {Address} */
        this._address = undefined;
        return this._init();
    }

    async _init() {
        const merkleRoot = await MerkleTree.computeRoot(this._publicKeys);
        this._address = Address.fromHash(merkleRoot);
        return this;
    }

    /**
     * Create a Transaction that still needs to be signed.
     * @param {Address} recipientAddr Address of the transaction receiver
     * @param {number} value Number of Satoshis to send.
     * @param {number} fee Number of Satoshis to donate to the Miner.
     * @param {number} nonce The nonce representing the current balance of the sender.
     * @returns {Transaction} A prepared Transaction object.
     */
    async createTransaction(recipientAddr, value, fee, nonce) {
        const transaction = new ExtendedTransaction(this._address, Account.Type.BASIC,
            recipientAddr, Account.Type.BASIC, value, fee, nonce, new Uint8Array(0));
        return transaction;
    }

    /**
     * Creates a commitment pair for signing a transaction.
     * @returns {Promise.<CommitmentPair>} The commitment pair.
     */
    createCommitment() {
        return CommitmentPair.generate();
    }

    /**
     * @param {Transaction} transaction
     * @param {Array.<PublicKey>} publicKeys
     * @param {Commitment} aggregatedCommitment
     * @param {RandomSecret} secret
     * @returns {Promise.<PartialSignature>}
     */
    async signTransaction(transaction, publicKeys, aggregatedCommitment, secret) {
        return await PartialSignature.create(this._keyPair.privateKey, this._keyPair.publicKey, publicKeys,
            secret, aggregatedCommitment, transaction.serializeContent());
    }

    /**
     * @param {Transaction} transaction
     * @param {PublicKey} aggregatedPublicKey
     * @param {Commitment} aggregatedCommitment
     * @param {Array.<PartialSignature>} signatures
     * @returns {Promise.<Transaction>}
     */
    async completeTransaction(transaction, aggregatedPublicKey, aggregatedCommitment, signatures) {
        if (signatures.length !== this._minSignatures) {
            throw 'Not enough signatures to complete this transaction';
        }

        const signature = await Signature.fromPartialSignatures(aggregatedCommitment, signatures);
        const proof = await SignatureProof.multiSig(aggregatedPublicKey, this._publicKeys, signature);
        transaction.proof = proof.serialize();
        return transaction;
    }

    /**
     * The address of the MultiSigWallet.
     * @type {Address}
     */
    get address() {
        return this._address;
    }

    /** @type {KeyPair} */
    get keyPair() {
        return this._keyPair;
    }
}
Class.register(MultiSigWallet);

/**
 * @interface
 */
class IWorker {
    static async createProxy(clazz, name, worker) {
        return new (IWorker.Proxy(clazz))(worker, name);
    }

    static async startWorkerForProxy(clazz, name, workerScript) {
        if (typeof Worker === 'undefined') {
            await IWorker._workerImplementation[clazz.name].init(name);
            return IWorker._workerImplementation[clazz.name];
        } else {
            if (!workerScript) {
                workerScript = `${Nimiq._path}worker.js`;
            }
            return IWorker.createProxy(clazz, name, new Worker(window.URL.createObjectURL(new Blob([`Nimiq = {_path: '${Nimiq._path}'}; importScripts('${workerScript.replace(/'/g, '')}');`]))));
        }
    }

    static async startWorkerPoolForProxy(clazz, name, size, workerScript) {
        return (new (IWorker.Pool(clazz))((name) => IWorker.startWorkerForProxy(clazz, name, workerScript), name, size)).start();
    }

    static async stubBaseOnMessage(msg) {
        try {
            if (msg.data.command == 'init') {
                if (IWorker._workerImplementation[msg.data.args[0]]) {
                    const res = await IWorker._workerImplementation[msg.data.args[0]].init(msg.data.args[1]);
                    self.postMessage({status: 'OK', result: res, id: msg.data.id});
                } else {
                    self.postMessage({status: 'error', result: 'Unknown worker!', id: msg.data.id});
                }
            } else {
                self.postMessage({status: 'error', result: 'Worker not yet initialized!', id: msg.data.id});
            }
        } catch (e) {
            self.postMessage({status: 'error', result: e, id: msg.data.id});
        }
    }

    static get areWorkersAsync() {
        return typeof Worker !== 'undefined';
    }

    static get _insideWebWorker() {
        return typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
    }

    static get _global() {
        return typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null;
    }

    static prepareForWorkerUse(baseClazz, impl) {
        if (IWorker._insideWebWorker) {
            // Only inside WebWorker
            self.onmessage = IWorker.stubBaseOnMessage;
        }
        IWorker._workerImplementation = IWorker._workerImplementation || {};
        IWorker._workerImplementation[baseClazz.name] = impl;
    }

    static fireModuleLoaded(module = 'Module') {
        if (typeof IWorker._moduleLoadedCallbacks[module] === 'function') {
            IWorker._moduleLoadedCallbacks[module]();
            IWorker._moduleLoadedCallbacks[module] = null;
        }
    }

    static _loadBrowserScript(url, resolve) {
        // Adding the script tag to the head as suggested before
        const head = document.getElementsByTagName('head')[0];
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = url;

        // Then bind the event to the callback function.
        // There are several events for cross browser compatibility.
        // These events might occur before processing, so delay them a bit.
        const ret = () => window.setTimeout(resolve, 100);
        script.onreadystatechange = ret;
        script.onload = ret;

        // Fire the loading
        head.appendChild(script);
    }

    static Proxy(clazz) {
        const proxyClass = class extends clazz {
            /**
             * @param {Worker} worker
             * @param {string} [name]
             */
            constructor(worker, name) {
                super();
                this._name = name;
                this._messageId = 0;
                this._worker = worker;
                this._worker.onmessage = this._receive.bind(this);
                /** @type {Map.<number,{resolve:Function,error:Function}>} */
                this._waiting = new Map();
                return this._invoke('init', [clazz.name, name]).then(() => { return this; });
            }

            _receive(msg) {
                const cb = this._waiting.get(msg.data.id);
                if (!cb) {
                    Log.w(WorkerProxy, 'Unknown reply', msg);
                } else {
                    this._waiting.delete(msg.data.id);
                    if (msg.data.status === 'OK') {
                        cb.resolve(msg.data.result);
                    } else if (msg.data.status === 'error') {
                        cb.error(msg.data.result);
                    }
                }
            }

            /**
             * @param {string} script
             * @returns {Promise.<boolean>}
             */
            importScript(script) {
                return this._invoke('importScript', [script]);
            }

            /**
             * @param {string} wasm
             * @param {string} module
             * @returns {Promise.<boolean>}
             */
            importWasm(wasm, module = 'Module') {
                return this._invoke('importWasm', [wasm, module]);
            }

            /**
             * @param {string} command
             * @param {object[]} [args]
             * @returns {Promise}
             * @private
             */
            _invoke(command, args = []) {
                return new Promise((resolve, error) => {
                    const obj = {command: command, args: args, id: this._messageId++};
                    this._waiting.set(obj.id, {resolve, error});
                    this._worker.postMessage(obj);
                });
            }

            async eval(code) {
                return this._invoke('eval', [code]);
            }

            async destroy() {
                this._invoke('destroy');
            }
        };
        for (const funcName of Object.getOwnPropertyNames(clazz.prototype)) {
            if (typeof clazz.prototype[funcName] === 'function' && funcName !== 'constructor') {
                proxyClass.prototype[funcName] = function (...args) {
                    return this._invoke(funcName, args);
                };
            }
        }
        return proxyClass;
    }

    /**
     * @param {object} clazz
     * @return {Stub}
     * @constructor
     */
    static Stub(clazz) {
        const Stub = class extends clazz {
            constructor() {
                super();
            }

            _result(msg, status, result) {
                self.postMessage({status, result, id: msg.data.id});
            }

            _onmessage(msg) {
                try {
                    const res = this._invoke(msg.data.command, msg.data.args);
                    if (res instanceof Promise) {
                        res.then((finalRes) => { this._result(msg, 'OK', finalRes); });
                    } else {
                        this._result(msg, 'OK', res);
                    }
                } catch (e) {
                    this._result(msg, 'error', e);
                }
            }

            eval(code) {
                // eslint-disable-next-line no-eval
                return eval(code);
            }

            async importScript(script, module = 'Module') {
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

            /**
             * @param {string} wasm
             * @param {string} module
             * @returns {Promise.<boolean>}
             */
            importWasm(wasm, module = 'Module') {
                if (typeof Nimiq !== 'undefined' && Nimiq._path) wasm = `${Nimiq._path}${wasm}`;
                if (typeof __dirname === 'string' && wasm.indexOf('/') === -1) wasm = `${__dirname}/${wasm}`;
                if (!IWorker._global.WebAssembly) {
                    Log.w(IWorker, 'No support for WebAssembly available.');
                    return Promise.resolve(false);
                }

                return new Promise((resolve) => {
                    try {
                        if (PlatformUtils.isNodeJs()) {
                            const toUint8Array = function (buf) {
                                const u = new Uint8Array(buf.length);
                                for (let i = 0; i < buf.length; ++i) {
                                    u[i] = buf[i];
                                }
                                return u;
                            };
                            const fs = require('fs');
                            fs.readFile(wasm, (err, data) => {
                                if (err) {
                                    Log.w(IWorker, `Failed to access WebAssembly module ${wasm}: ${err}`);
                                    resolve(false);
                                } else {
                                    IWorker._global[module] = IWorker._global[module] || {};
                                    IWorker._global[module].wasmBinary = toUint8Array(data);
                                    resolve(true);
                                }
                            });
                        } else {
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
                        }
                    } catch (e) {
                        Log.w(IWorker, `Failed to access WebAssembly module ${wasm}`);
                        resolve(false);
                    }
                });
            }

            init(name) {
                this._name = name;
                if (IWorker._insideWebWorker) {
                    self.name = name;
                    self.onmessage = (msg) => this._onmessage(msg);
                }
            }

            _invoke(command, args) {
                return this[command].apply(this, args);
            }

            destroy() {
                if (IWorker._insideWebWorker) {
                    self.close();
                }
            }
        };
        for (const funcName of Object.getOwnPropertyNames(clazz.prototype)) {
            if (typeof clazz.prototype[funcName] === 'function' && funcName !== 'constructor') {
                Stub.prototype[funcName] = function () {
                    throw `Not implemented in IWorker Stub: ${funcName}`;
                };
            }
        }
        return Stub;
    }

    static Pool(clazz) {
        const poolClass = class extends clazz {
            /**
             *
             * @param {function(string):Promise} proxyInitializer
             * @param {string} [name]
             * @param {number} [size] Number of workers in this pool.
             */
            constructor(proxyInitializer, name = 'pool', size = 1) {
                super();
                /** @type {function(string):Promise} */
                this._proxyInitializer = proxyInitializer;
                /** @type {string} */
                this._name = name;
                /** @type {number} */
                this._poolSize = size;
                /** @type {Array} */
                this._workers = [];
                /** @type {Array} */
                this._freeWorkers = [];
                /** @type {Array.<{name:string, args:Array, resolve:function, error:function}>} */
                this._waitingCalls = [];
            }

            async start() {
                await this._updateToSize();

                return this;
            }

            get poolSize() {
                return this._poolSize;
            }

            set poolSize(_size) {
                this._poolSize = _size;
                this._updateToSize();
            }

            async destroy() {
                this._poolSize = 0;
                this._updateToSize();
            }

            /**
             * @param {string} name Name of the function to call on a worker
             * @param {Array} args Arguments to pass to the function
             * @returns {Promise}
             */
            _invoke(name, args) {
                return new Promise((resolve, error) => {
                    this._waitingCalls.push({name, args, resolve, error});
                    const worker = this._freeWorkers.shift();
                    if (worker) {
                        this._step(worker);
                    }
                });
            }

            /**
             * @param worker
             * @returns {Promise.<void>}
             * @private
             */
            async _step(worker) {
                let call = this._waitingCalls.shift();
                while (call) {
                    // eslint-disable-next-line no-await-in-loop
                    await worker[call.name].apply(worker, call.args).then(call.resolve).catch(call.error);
                    if (this._workers.indexOf(worker) === -1) {
                        worker.destroy();
                        return;
                    }
                    call = this._waitingCalls.shift();
                }
                this._freeWorkers.push(worker);
            }

            async _updateToSize() {
                if (typeof Worker === 'undefined' && this._poolSize > 1) {
                    Log.d(IWorker, 'Pool of size larger than 1 requires WebWorker support.');
                    this._poolSize = 1;
                }

                const workerPromises = [];
                while (this._workers.length + workerPromises.length < this._poolSize) {
                    workerPromises.push(this._proxyInitializer(`${this._name}#${this._workers.length + workerPromises.length}`));
                }
                const createdWorkers = await Promise.all(workerPromises);
                for (const worker of createdWorkers) {
                    this._workers.push(worker);
                    this._step(worker);
                }

                while (this._workers.length > this._poolSize) {
                    const worker = this._freeWorkers.shift() || this._workers.pop();
                    const idx = this._workers.indexOf(worker);
                    if (idx >= 0) {
                        // This was a free worker, also remove it from the worker list and destroy it now.
                        this._workers.splice(idx, 1);
                        worker.destroy();
                    }
                }
                return this;
            }
        };
        for (const funcName of Object.getOwnPropertyNames(clazz.prototype)) {
            if (typeof clazz.prototype[funcName] === 'function' && funcName !== 'constructor') {
                poolClass.prototype[funcName] = function (...args) {
                    return this._invoke(funcName, args);
                };
            }
        }
        return poolClass;
    }
}

IWorker._moduleLoadedCallbacks = {};
IWorker._workerImplementation = {};
Class.register(IWorker);

/**
 * @interface
 */
class CryptoWorker {
    /**
     * @param {Uint8Array} input
     * @returns {Promise.<Uint8Array>}
     */
    async computeLightHash(input) {}

    /**
     * @param {Uint8Array} input
     * @param {Uint8Array} hash
     */
    async verifyLightHash(input, hash) {}

    /**
     * @param {Uint8Array} input
     * @returns {Promise.<Uint8Array>}
     */
    async computeHardHash(input) {}

    /**
     * @param {Array.<Uint8Array>} inputs
     * @returns {Promise.<Array.<Uint8Array>>}
     */
    async computeHardHashBatch(inputs) {}

    /**
     * @param {Uint8Array} input
     * @param {Uint8Array} hash
     */
    async verifyHardHash(input, hash) {}

    /**
     * @param {Uint8Array} key
     * @param {Uint8Array} seed
     * @returns {Promise.<Uint8Array>}
     */
    async kdf(key, seed) {}

    /**
     * @param privateKey
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeyDerive(privateKey) {}

    /**
     * @param {Uint8Array} randomness
     * @returns {Promise.<{commitment:Uint8Array, secret:Uint8Array}>}
     */
    async commitmentCreate(randomness) {}

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    scalarsAdd(a, b) {}

    /**
     * @param {Array.<Uint8Array>} commitments
     * @returns {Promise.<Uint8Array>}
     */
    async commitmentsAggregate(commitments) {}

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeysHash(publicKeys) {}

    /**
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeyDelinearize(publicKey, publicKeysHash) {}

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeysDelinearizeAndAggregate(publicKeys, publicKeysHash) {}

    /**
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async privateKeyDelinearize(privateKey, publicKey, publicKeysHash) {}

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} secret
     * @param {Uint8Array} aggregateCommitment
     * @param {Uint8Array} message
     * @returns {Promise.<Uint8Array>}
     */
    async delinearizedPartialSignatureCreate(publicKeys, privateKey, publicKey, secret, aggregateCommitment, message) {}

    /**
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @returns {Promise.<Uint8Array>}
     */
    async signatureCreate(privateKey, publicKey, message) {}

    /**
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @param {Uint8Array} signature
     * @returns {Promise.<bool>}
     */
    async signatureVerify(publicKey, message, signature) {}
}
CryptoWorker.HASH_SIZE = 32;
CryptoWorker.PUBLIC_KEY_SIZE = 32;
CryptoWorker.PRIVATE_KEY_SIZE = 32;
CryptoWorker.MULTISIG_RANDOMNESS_SIZE = 32;
CryptoWorker.SIGNATURE_SIZE = 64;
CryptoWorker.PARTIAL_SIGNATURE_SIZE = 32;
CryptoWorker.SIGNATURE_HASH_SIZE = 64;
Class.register(CryptoWorker);

class CryptoWorkerImpl extends IWorker.Stub(CryptoWorker) {
    constructor() {
        super();
        // FIXME: This is needed for Babel to work correctly. Can be removed as soon as we updated to Babel v7.
        this._superInit = super.init;
    }

    async init(name) {
        await this._superInit.call(this, name);

        if (await this.importWasm('worker-wasm.wasm')) {
            await this.importScript('worker-wasm.js');
        } else {
            await this.importScript('worker-js.js');
        }

        const memoryStart = Module._get_static_memory_start();
        const memorySize = Module._get_static_memory_size();
        if (memorySize < CryptoWorker.PUBLIC_KEY_SIZE + CryptoWorker.PRIVATE_KEY_SIZE + CryptoWorker.SIGNATURE_SIZE) {
            throw Error('Static memory too small');
        }
        let byteOffset = memoryStart;
        this._pubKeyPointer = byteOffset;
        this._pubKeyBuffer = new Uint8Array(Module.HEAP8.buffer, byteOffset, CryptoWorker.PUBLIC_KEY_SIZE);
        byteOffset += CryptoWorker.PUBLIC_KEY_SIZE;
        this._privKeyPointer = byteOffset;
        this._privKeyBuffer = new Uint8Array(Module.HEAP8.buffer, byteOffset, CryptoWorker.PRIVATE_KEY_SIZE);
        byteOffset += CryptoWorker.PRIVATE_KEY_SIZE;
        this._signaturePointer = byteOffset;
        this._signatureBuffer = new Uint8Array(Module.HEAP8.buffer, byteOffset, CryptoWorker.SIGNATURE_SIZE);
        byteOffset += CryptoWorker.SIGNATURE_SIZE;
        this._messagePointer = byteOffset;
        this._messageBuffer = new Uint8Array(Module.HEAP8.buffer, byteOffset, (memoryStart + memorySize) - byteOffset);
    }

    /**
     * @param {Uint8Array} input
     * @returns {Uint8Array}
     */
    computeLightHash(input) {
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.HASH_SIZE);
            const wasmIn = Module.stackAlloc(input.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmIn, input.length).set(input);
            const res = Module._nimiq_light_hash(wasmOut, wasmIn, input.length);
            if (res !== 0) {
                throw res;
            }
            const hash = new Uint8Array(CryptoWorker.HASH_SIZE);
            hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.HASH_SIZE));
            return hash;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} input
     * @returns {Promise.<Uint8Array>}
     */
    async computeHardHash(input) {
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.HASH_SIZE);
            const wasmIn = Module.stackAlloc(input.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmIn, input.length).set(input);
            const res = Module._nimiq_hard_hash(wasmOut, wasmIn, input.length, 512);
            if (res !== 0) {
                throw res;
            }
            const hash = new Uint8Array(CryptoWorker.HASH_SIZE);
            hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.HASH_SIZE));
            return hash;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Array.<Uint8Array>} inputs
     * @returns {Promise.<Array.<Uint8Array>>}
     */
    async computeHardHashBatch(inputs) {
        const hashes = [];
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.HASH_SIZE);
            const stackTmp = Module.stackSave();
            for(const input of inputs) {
                Module.stackRestore(stackTmp);
                const wasmIn = Module.stackAlloc(input.length);
                new Uint8Array(Module.HEAPU8.buffer, wasmIn, input.length).set(input);
                const res = Module._nimiq_hard_hash(wasmOut, wasmIn, input.length, 512);
                if (res !== 0) {
                    throw res;
                }
                const hash = new Uint8Array(CryptoWorker.HASH_SIZE);
                hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.HASH_SIZE));
                hashes.push(hash);
            }
            return hashes;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} key
     * @param {Uint8Array} seed
     * @returns {Promise.<Uint8Array>}
     */
    async kdf(key, seed) {
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.HASH_SIZE);
            const wasmIn = Module.stackAlloc(key.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmIn, key.length).set(key);
            const wasmSeed = Module.stackAlloc(seed.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmSeed, seed.length).set(seed);
            const res = Module._nimiq_kdf(wasmOut, wasmIn, key.length, wasmSeed, seed.length, 512, 256);
            if (res !== 0) {
                throw res;
            }
            const hash = new Uint8Array(CryptoWorker.HASH_SIZE);
            hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.HASH_SIZE));
            return hash;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} privateKey
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeyDerive(privateKey) {
        const publicKey = new Uint8Array(CryptoWorker.PUBLIC_KEY_SIZE);
        if (privateKey.byteLength !== CryptoWorker.PRIVATE_KEY_SIZE) {
            throw Error('Wrong buffer size.');
        }
        this._privKeyBuffer.set(privateKey);
        Module._ed25519_public_key_derive(this._pubKeyPointer, this._privKeyPointer);
        this._privKeyBuffer.fill(0);
        publicKey.set(this._pubKeyBuffer);
        return publicKey;
    }

    /**
     * @param {Uint8Array} randomness
     * @returns {Promise.<{commitment:Uint8Array, secret:Uint8Array}>}
     */
    async commitmentCreate(randomness) {
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOutCommitment = Module.stackAlloc(CryptoWorker.PUBLIC_KEY_SIZE);
            const wasmOutSecret = Module.stackAlloc(CryptoWorker.PRIVATE_KEY_SIZE);
            const wasmIn = Module.stackAlloc(randomness.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmIn, randomness.length).set(randomness);
            const res = Module._ed25519_create_commitment(wasmOutSecret, wasmOutCommitment, wasmIn);
            if (res !== 1) {
                throw new Error('Secret must not be 0 or 1: ' + res);
            }
            const commitment = new Uint8Array(CryptoWorker.PUBLIC_KEY_SIZE);
            const secret = new Uint8Array(CryptoWorker.PRIVATE_KEY_SIZE);
            commitment.set(new Uint8Array(Module.HEAPU8.buffer, wasmOutCommitment, CryptoWorker.PUBLIC_KEY_SIZE));
            secret.set(new Uint8Array(Module.HEAPU8.buffer, wasmOutSecret, CryptoWorker.PRIVATE_KEY_SIZE));
            return {commitment, secret};
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    scalarsAdd(a, b) {
        if (a.byteLength !== CryptoWorker.PARTIAL_SIGNATURE_SIZE || b.byteLength !== CryptoWorker.PARTIAL_SIGNATURE_SIZE) {
            throw Error('Wrong buffer size.');
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOutSum = Module.stackAlloc(CryptoWorker.PARTIAL_SIGNATURE_SIZE);
            const wasmInA = Module.stackAlloc(a.length);
            const wasmInB = Module.stackAlloc(b.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInA, a.length).set(a);
            new Uint8Array(Module.HEAPU8.buffer, wasmInB, b.length).set(b);
            Module._ed25519_add_scalars(wasmOutSum, wasmInA, wasmInB);
            const sum = new Uint8Array(CryptoWorker.PARTIAL_SIGNATURE_SIZE);
            sum.set(new Uint8Array(Module.HEAPU8.buffer, wasmOutSum, CryptoWorker.PARTIAL_SIGNATURE_SIZE));
            return sum;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Array.<Uint8Array>} commitments
     * @returns {Promise.<Uint8Array>}
     */
    async commitmentsAggregate(commitments) {
        if (commitments.some(commitment => commitment.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE)) {
            throw Error('Wrong buffer size.');
        }
        const concatenatedCommitments = new Uint8Array(commitments.length * CryptoWorker.PUBLIC_KEY_SIZE);
        for (let i = 0; i < commitments.length; ++i) {
            concatenatedCommitments.set(commitments[i], i * CryptoWorker.PUBLIC_KEY_SIZE);
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.PUBLIC_KEY_SIZE);
            const wasmInCommitments = Module.stackAlloc(concatenatedCommitments.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInCommitments, concatenatedCommitments.length).set(concatenatedCommitments);
            Module._ed25519_aggregate_commitments(wasmOut, wasmInCommitments, commitments.length);
            const aggCommitments = new Uint8Array(CryptoWorker.PUBLIC_KEY_SIZE);
            aggCommitments.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.PUBLIC_KEY_SIZE));
            return aggCommitments;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeysHash(publicKeys) {
        if (publicKeys.some(publicKey => publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE)) {
            throw Error('Wrong buffer size.');
        }
        const concatenatedPublicKeys = new Uint8Array(publicKeys.length * CryptoWorker.PUBLIC_KEY_SIZE);
        for (let i = 0; i < publicKeys.length; ++i) {
            concatenatedPublicKeys.set(publicKeys[i], i * CryptoWorker.PUBLIC_KEY_SIZE);
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.SIGNATURE_HASH_SIZE);
            const wasmInPublicKeys = Module.stackAlloc(concatenatedPublicKeys.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeys, concatenatedPublicKeys.length).set(concatenatedPublicKeys);
            Module._ed25519_hash_public_keys(wasmOut, wasmInPublicKeys, publicKeys.length);
            const hashedPublicKey = new Uint8Array(CryptoWorker.SIGNATURE_HASH_SIZE);
            hashedPublicKey.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.SIGNATURE_HASH_SIZE));
            return hashedPublicKey;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeyDelinearize(publicKey, publicKeysHash) {
        if (publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE
            || publicKeysHash.byteLength !== CryptoWorker.SIGNATURE_HASH_SIZE) {
            throw Error('Wrong buffer size.');
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.PUBLIC_KEY_SIZE);
            const wasmInPublicKey = Module.stackAlloc(publicKey.length);
            const wasmInPublicKeysHash = Module.stackAlloc(publicKeysHash.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKey, publicKey.length).set(publicKey);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeysHash, publicKeysHash.length).set(publicKeysHash);
            Module._ed25519_delinearize_public_key(wasmOut, wasmInPublicKeysHash, wasmInPublicKey);
            const delinearizedPublicKey = new Uint8Array(CryptoWorker.PUBLIC_KEY_SIZE);
            delinearizedPublicKey.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.PUBLIC_KEY_SIZE));
            return delinearizedPublicKey;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async publicKeysDelinearizeAndAggregate(publicKeys, publicKeysHash) {
        if (publicKeys.some(publicKey => publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE)
            || publicKeysHash.byteLength !== CryptoWorker.SIGNATURE_HASH_SIZE) {
            throw Error('Wrong buffer size.');
        }
        const concatenatedPublicKeys = new Uint8Array(publicKeys.length * CryptoWorker.PUBLIC_KEY_SIZE);
        for (let i = 0; i < publicKeys.length; ++i) {
            concatenatedPublicKeys.set(publicKeys[i], i * CryptoWorker.PUBLIC_KEY_SIZE);
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.PUBLIC_KEY_SIZE);
            const wasmInPublicKeys = Module.stackAlloc(concatenatedPublicKeys.length);
            const wasmInPublicKeysHash = Module.stackAlloc(publicKeysHash.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeys, concatenatedPublicKeys.length).set(concatenatedPublicKeys);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeysHash, publicKeysHash.length).set(publicKeysHash);
            Module._ed25519_aggregate_delinearized_public_keys(wasmOut, wasmInPublicKeysHash, wasmInPublicKeys, publicKeys.length);
            const aggregatePublicKey = new Uint8Array(CryptoWorker.PUBLIC_KEY_SIZE);
            aggregatePublicKey.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.PUBLIC_KEY_SIZE));
            return aggregatePublicKey;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} publicKeysHash
     * @returns {Promise.<Uint8Array>}
     */
    async privateKeyDelinearize(privateKey, publicKey, publicKeysHash) {
        if (privateKey.byteLength !== CryptoWorker.PRIVATE_KEY_SIZE
            || publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE
            || publicKeysHash.byteLength !== CryptoWorker.SIGNATURE_HASH_SIZE) {
            throw Error('Wrong buffer size.');
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.PUBLIC_KEY_SIZE);
            const wasmInPrivateKey = Module.stackAlloc(privateKey.length);
            const wasmInPublicKey = Module.stackAlloc(publicKey.length);
            const wasmInPublicKeysHash = Module.stackAlloc(publicKeysHash.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPrivateKey, privateKey.length).set(privateKey);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKey, publicKey.length).set(publicKey);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeysHash, publicKeysHash.length).set(publicKeysHash);
            Module._ed25519_derive_delinearized_private_key(wasmOut, wasmInPublicKeysHash, wasmInPublicKey, wasmInPrivateKey);
            const delinearizedPrivateKey = new Uint8Array(CryptoWorker.PRIVATE_KEY_SIZE);
            delinearizedPrivateKey.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.PRIVATE_KEY_SIZE));
            return delinearizedPrivateKey;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Array.<Uint8Array>} publicKeys
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} secret
     * @param {Uint8Array} aggregateCommitment
     * @param {Uint8Array} message
     * @returns {Promise.<Uint8Array>}
     */
    async delinearizedPartialSignatureCreate(publicKeys, privateKey, publicKey, secret, aggregateCommitment, message) {
        if (publicKeys.some(publicKey => publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE)
            || privateKey.byteLength !== CryptoWorker.PRIVATE_KEY_SIZE
            || publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE
            || secret.byteLength !== CryptoWorker.PRIVATE_KEY_SIZE
            || aggregateCommitment.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE) {
            throw Error('Wrong buffer size.');
        }
        const concatenatedPublicKeys = new Uint8Array(publicKeys.length * CryptoWorker.PUBLIC_KEY_SIZE);
        for (let i = 0; i < publicKeys.length; ++i) {
            concatenatedPublicKeys.set(publicKeys[i], i * CryptoWorker.PUBLIC_KEY_SIZE);
        }
        let stackPtr;
        try {
            stackPtr = Module.stackSave();
            const wasmOut = Module.stackAlloc(CryptoWorker.PARTIAL_SIGNATURE_SIZE);
            const wasmInPublicKeys = Module.stackAlloc(concatenatedPublicKeys.length);
            const wasmInPrivateKey = Module.stackAlloc(privateKey.length);
            const wasmInPublicKey = Module.stackAlloc(publicKey.length);
            const wasmInSecret = Module.stackAlloc(secret.length);
            const wasmInCommitment = Module.stackAlloc(aggregateCommitment.length);
            const wasmInMessage = Module.stackAlloc(message.length);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKeys, concatenatedPublicKeys.length).set(concatenatedPublicKeys);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPrivateKey, privateKey.length).set(privateKey);
            new Uint8Array(Module.HEAPU8.buffer, wasmInPublicKey, publicKey.length).set(publicKey);
            new Uint8Array(Module.HEAPU8.buffer, wasmInSecret, secret.length).set(secret);
            new Uint8Array(Module.HEAPU8.buffer, wasmInCommitment, aggregateCommitment.length).set(aggregateCommitment);
            new Uint8Array(Module.HEAPU8.buffer, wasmInMessage, message.length).set(message);
            Module._ed25519_delinearized_partial_sign(wasmOut, wasmInMessage, message.length, wasmInCommitment, wasmInSecret, wasmInPublicKeys, publicKeys.length, wasmInPublicKey, wasmInPrivateKey);
            const partialSignature = new Uint8Array(CryptoWorker.PARTIAL_SIGNATURE_SIZE);
            partialSignature.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, CryptoWorker.PARTIAL_SIGNATURE_SIZE));
            return partialSignature;
        } catch (e) {
            Log.w(CryptoWorkerImpl, e);
            throw e;
        } finally {
            if (stackPtr !== undefined) Module.stackRestore(stackPtr);
        }
    }

    /**
     * @param {Uint8Array} privateKey
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @returns {Promise.<Uint8Array>}
     */
    async signatureCreate(privateKey, publicKey, message) {
        const signature = new Uint8Array(CryptoWorker.SIGNATURE_SIZE);
        const messageLength = message.byteLength;
        if (messageLength > this._messageBuffer.byteLength
            || publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE
            || privateKey.byteLength !== CryptoWorker.PRIVATE_KEY_SIZE) {
            throw Error('Wrong buffer size.');
        }
        this._messageBuffer.set(message);
        this._pubKeyBuffer.set(publicKey);
        this._privKeyBuffer.set(privateKey);
        Module._ed25519_sign(this._signaturePointer, this._messagePointer, messageLength,
            this._pubKeyPointer, this._privKeyPointer);
        this._privKeyBuffer.fill(0);
        signature.set(this._signatureBuffer);
        return signature;
    }

    /**
     * @param {Uint8Array} publicKey
     * @param {Uint8Array} message
     * @param {Uint8Array} signature
     * @returns {Promise.<bool>}
     */
    async signatureVerify(publicKey, message, signature) {
        const messageLength = message.byteLength;
        if (signature.byteLength !== CryptoWorker.SIGNATURE_SIZE
            || message.byteLength > this._messageBuffer.byteLength
            || publicKey.byteLength !== CryptoWorker.PUBLIC_KEY_SIZE) {
            throw Error('Wrong buffer size.');
        }
        this._signatureBuffer.set(signature);
        this._messageBuffer.set(message);
        this._pubKeyBuffer.set(publicKey);
        return !!Module._ed25519_verify(this._signaturePointer, this._messagePointer, messageLength,
            this._pubKeyPointer);
    }
}

IWorker.prepareForWorkerUse(CryptoWorker, new CryptoWorkerImpl());

/**
 * @interface
 */
class MinerWorker {
    /**
     * @param blockHeader
     * @param compact
     * @param minNonce
     * @param maxNonce
     * @returns {Promise.<{hash: Uint8Array, nonce: number}|boolean>}
     */
    async multiMine(blockHeader, compact, minNonce, maxNonce) {}
}
Class.register(MinerWorker);

class MinerWorkerImpl extends IWorker.Stub(MinerWorker) {
    constructor() {
        super();
        // FIXME: This is needed for Babel to work correctly. Can be removed as soon as we updated to Babel v7.
        this._superInit = super.init;
    }

    async init(name) {
        await this._superInit.call(this, name);

        if (await this.importWasm('worker-wasm.wasm')) {
            await this.importScript('worker-wasm.js');
        } else {
            await this.importScript('worker-js.js');
        }
    }

    async multiMine(input, compact, minNonce, maxNonce) {
        const hash = new Uint8Array(32);
        let wasmOut, wasmIn;
        try {
            wasmOut = Module._malloc(hash.length);
            wasmIn = Module._malloc(input.length);
            Module.HEAPU8.set(input, wasmIn);
            const nonce = Module._nimiq_hard_hash_target(wasmOut, wasmIn, input.length, compact, minNonce, maxNonce, 512);
            if (nonce === maxNonce) return false;
            hash.set(new Uint8Array(Module.HEAPU8.buffer, wasmOut, hash.length));
            return {hash, nonce};
        } catch (e) {
            Log.w(MinerWorkerImpl, e);
            throw e;
        } finally {
            if (wasmOut !== undefined) Module._free(wasmOut);
            if (wasmIn !== undefined) Module._free(wasmIn);
        }
    }
}

IWorker.prepareForWorkerUse(MinerWorker, new MinerWorkerImpl());

/**
 *
 */
class MinerWorkerPool extends IWorker.Pool(MinerWorker) {
    constructor(size = 1) {
        super((name) => IWorker.startWorkerForProxy(MinerWorker, name), 'miner', size);
        /** @type {boolean} */
        this._miningEnabled = false;
        /** @type {Array.<{minNonce: number, maxNonce: number}>} */
        this._activeNonces = [];
        /** @type {Block} */
        this._block = null;
        /** @type {number} */
        this._noncesPerRun = 256;
        /** @type {Observable} */
        this._observable = new Observable();
        /** @type {number} */
        this._shareCompact = Policy.BLOCK_TARGET_MAX;
        /** @type {number} */
        this._runsPerCycle = Infinity;
        /** @type {number} */
        this._cycleWait = 100;

        // FIXME: This is needed for Babel to work correctly. Can be removed as soon as we updated to Babel v7.
        this._superUpdateToSize = super._updateToSize;

        if (PlatformUtils.isNodeJs()) {
            const nimiq_node = require(`${__dirname}/nimiq_node`);
            /**
             * @param {SerialBuffer} blockHeader
             * @param {number} compact
             * @param {number} minNonce
             * @param {number} maxNonce
             * @returns {Promise.<{hash: Uint8Array, nonce: number}|boolean>}
             */
            this.multiMine = function (blockHeader, compact, minNonce, maxNonce) {
                return new Promise((resolve, fail) => {
                    nimiq_node.nimiq_hard_hash_target_async(async (nonce) => {
                        try {
                            if (nonce === maxNonce) {
                                resolve(false);
                            } else {
                                blockHeader.writePos -= 4;
                                blockHeader.writeUint32(nonce);
                                const hash = await Crypto.hashHard(blockHeader);
                                resolve({hash, nonce});
                            }
                        } catch (e) {
                            fail(e);
                        }
                    }, blockHeader, compact, minNonce, maxNonce, 512);
                });
            };
        }
    }

    /**
     * @type {number}
     */
    get noncesPerRun() {
        return this._noncesPerRun;
    }

    /**
     * @param {number} nonces
     */
    set noncesPerRun(nonces) {
        this._noncesPerRun = nonces;
    }

    /**
     * @type {number}
     */
    get runsPerCycle() {
        return this._runsPerCycle;
    }

    /**
     * @param {number} runsPerCycle
     */
    set runsPerCycle(runsPerCycle) {
        this._runsPerCycle = runsPerCycle;
    }

    /**
     * @type {number}
     */
    get cycleWait() {
        return this._cycleWait;
    }

    /**
     * @param {number} cycleWait
     */
    set cycleWait(cycleWait) {
        this._cycleWait = cycleWait;
    }

    /**
     * @param {string} type
     * @param {Function} callback
     * @return {number}
     */
    on(type, callback) { this._observable.on(type, callback); }

    /**
     * @param {string} type
     * @param {number} id
     */
    off(type, id) { this._observable.off(type, id); }

    /**
     * @param {Block} block
     * @param {number} shareCompact target of a share, in compact format.
     */
    async startMiningOnBlock(block, shareCompact = block.nBits) {
        this._block = block;
        this._shareCompact = shareCompact;
        if (!this._miningEnabled) {
            await this._updateToSize();
            this._activeNonces = [];
            this._miningEnabled = true;
            for (let i = 0; i < this.poolSize; ++i) {
                this._startMiner();
            }
        } else {
            this._activeNonces = [{minNonce:0, maxNonce:0}];
        }
    }

    stop() {
        this._miningEnabled = false;
    }

    async _updateToSize() {
        if (!PlatformUtils.isNodeJs()) {
            await this._superUpdateToSize.call(this);
        }

        while (this._miningEnabled && this._activeNonces.length < this.poolSize) {
            this._startMiner();
        }
    }

    _startMiner() {
        const minNonce = this._activeNonces.length === 0 ? 0 : Math.max.apply(null, this._activeNonces.map((a) => a.maxNonce));
        const maxNonce = minNonce + this._noncesPerRun;
        const nonceRange = {minNonce, maxNonce};
        this._activeNonces.push(nonceRange);
        this._singleMiner(nonceRange).catch((e) => Log.e(MinerWorkerPool, e));
    }

    /**
     * @param {{minNonce: number, maxNonce: number}} nonceRange
     * @return {Promise.<void>}
     * @private
     */
    async _singleMiner(nonceRange) {
        let i = 0;
        while (this._miningEnabled && (IWorker.areWorkersAsync || PlatformUtils.isNodeJs() || i === 0) && i < this._runsPerCycle) {
            i++;
            const block = this._block;
            const result = await this.multiMine(block.header.serialize(), this._shareCompact, nonceRange.minNonce, nonceRange.maxNonce);
            if (result) {
                const hash = new Hash(result.hash);
                this._observable.fire('share', {
                    block,
                    nonce: result.nonce,
                    hash
                });
            } else {
                this._observable.fire('no-share', {
                    nonce: nonceRange.maxNonce
                });
            }
            if (this._activeNonces.length > this.poolSize) {
                this._activeNonces.splice(this._activeNonces.indexOf(nonceRange), 1);
                return;
            } else {
                const newMin = Math.max.apply(null, this._activeNonces.map((a) => a.maxNonce));
                const newRange = {minNonce: newMin, maxNonce: newMin + this._noncesPerRun};
                this._activeNonces.splice(this._activeNonces.indexOf(nonceRange), 1, newRange);
                nonceRange = newRange;
            }
        }
        if (this._miningEnabled) {
            setTimeout(() => this._singleMiner(nonceRange), this._cycleWait);
        }
    }
}

Class.register(MinerWorkerPool);

    exports._loaded = true;
    if (typeof exports._onload === 'function') exports._onload();
    return exports;
})(Nimiq);

//# sourceMappingURL=web.js.map
