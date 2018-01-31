import React, { Component } from 'react';
import { Row, Col, Form, Icon, Input, Tooltip, Radio, Switch, Slider, message } from 'antd';
import intl from 'react-intl-universal';
import './App.css';
import Miner from './Miner.js';
import StateCard from './components/StateCard.js';
import HashFig from './components/HashFig.js';

const locales = {
  "en-US": require('./locales/en-US.js'),
  "zh-CN": require('./locales/zh-CN.js'),
};

const Nimiq = window.Nimiq;
const FormItem = Form.Item;
const RadioButton = Radio.Button;
const RadioGroup = Radio.Group;
message.config({
  duration: 5,
});

class App extends Component {

  updateInterval = null;
  startMiningTime = new Date();
  hashrateHistory = [];

  state = {
    isAbleMining: false,
    switch: false,
    server: 'sh1',
    address: 'NQ48 8CKH BA24 2VR3 N249 N8MN J5XX 74DB 5XJ8',
    name: '*',
    thread: 0,
    miningState: 'default',
    hashrate: 0,
    miningTime: 0,
    hashrateHistory: [],
  }

  constructor() {
    super();
    if (typeof navigator === 'object' && navigator.hardwareConcurrency) {
      this.MaxThreads = navigator.hardwareConcurrency;
    } else {
      this.MaxThreads = 8;
    }
    this.state.thread = this.MaxThreads - 1;

    this.loadLocales();
    this.init();
    this.serverComp = null;
    this.server = null;
    this.addressComp = null;
    this.address = null;
    this.nameComp = null;
    this.name = null;
    this.threadComp = null;
    this.thread = null;
    if (localStorage.getItem('server') !== null) {
      this.state.server = localStorage.getItem('server');
    }
    if (localStorage.getItem('address') !== null) {
      this.state.address = localStorage.getItem('address');
    }
    if (localStorage.getItem('name') !== null) {
      this.state.name = localStorage.getItem('name');
    }
    if (localStorage.getItem('thread') !== null) {
      this.state.thread = parseInt(localStorage.getItem('thread'), 10);
    }
    this.updateHashFigObject = setInterval(() => {
      this.updateHashFig();
    }, 5000);
    this.updateHashFigCount = 0;
  }

  loadLocales() {
    const locale = localStorage.getItem('language') || 'zh-CN';
    intl.init({
      currentLocale: locale,
      locales,
    })
  }

  init() {
    Nimiq.init(async () => {
      console.log('init success');
      this.miner = new Miner();
      this.setState({
        isAbleMining: true,
      });

    }, code => {
      switch (code) {
        case Nimiq.ERR_WAIT:
          message.error(intl.get('errorTooManyPage'));
          break;
        case Nimiq.ERR_UNSUPPORTED:
          message.error(intl.get('errorUnsupport'));
          break;
        default:
          message.error(intl.get('errorInitFail'));
          break;
      }
    });
  }

  start() {
    const server = `https://${this.server}.nimiq.skypool.org`;
    this.miner.start(server, this.address, this.name, this.thread);
  }

  stop() {
    this.miner.stop();
  }

  updateIntervalFunc() {
    const miningState = this.miner.miningState;
    const hashrate = this.miner.hashrate;
    const miningTime = new Date() - this.startMiningTime;
    this.setState({
      miningState: miningState,
      hashrate: hashrate,
      miningTime: miningTime,
    });
  }

  updateHashFig() {
    this.updateHashFigCount++;
    if (this.updateHashFigCount > this.hashrateHistory.length / 10) {
      this.updateHashFigCount = 0;
      const hashrate = this.state.switch ? this.miner.hashrate : 0;
      this.hashrateHistory.push({
        time: new Date(),
        hashrate: hashrate,
      });
      if (this.hashrateHistory.length > 50) {
        this.hashrateHistory.shift();
      }
      this.setState({
        hashrateHistory : this.hashrateHistory,
      });
    }
  }

  switchMining(checked) {
    this.setState({
      switch: checked,
    });
    if (checked) {
      const server = this.serverComp.state.value;
      const address = this.addressComp.input.value;
      const name = this.nameComp.input.value;
      const thread = this.threadComp.rcSlider.state.value;
      if (address.length !== 44) {
        message.error(intl.get('errorAddressFormat'));
        this.setState({
          switch: false,
        });
        return;
      }
      if (name.length < 1) {
        message.error(intl.get('errorNameEmpty'));
        this.setState({
          switch: false,
        });
        return;
      }
      if (name.length > 30) {
        message.error(intl.get('errorNameTooLong'));
        this.setState({
          switch: false,
        });
        return;
      }
      if (thread < 1) {
        message.error(intl.get('errorThreadZero'));
        this.setState({
          switch: false,
        });
        return;
      }

      this.server = server;
      this.address = address;
      this.name = name;
      this.thread = thread;
      this.setState({
        server: this.server,
        address: this.address,
        name: this.name,
        thread: this.thread,
      });
      this.startMiningTime = new Date();
      this.updateInterval = setInterval(() => {
        this.updateIntervalFunc();
      }, 1000);
      localStorage.setItem('server', server);
      localStorage.setItem('address', address);
      localStorage.setItem('name', name);
      localStorage.setItem('thread', thread);
      this.start();
    } else {
      clearInterval(this.updateInterval);
      this.setState({
        miningState: 'default',
        hashrate: 0,
      });
      this.stop();
    }
  }

  changeLanguage() {
    let language = localStorage.getItem('language');
    if (language === null || language === 'zh-CN') {
      localStorage.setItem('language', 'en-US');
      console.log('change to en-US');
      window.location.reload();
    } else {
      localStorage.setItem('language', 'zh-CN');
      console.log('change to zh-CN');
      window.location.reload();
    }
  }

  render() {
    const MaxThreads = this.MaxThreads;
    const formItemLayout = {
      labelCol: {
        xs: { span: 24 },
        sm: { span: 4 },
      },
      wrapperCol: {
        xs: { span: 24 },
        sm: { span: 20 },
      },
    };

    return (
      <div className="App">
        <header style={{ marginBottom: '24px' }}>
          <Row type="flex" justify="space-around" align="bottom">
            <Col md={8} sm={0} xs={0}/>
            <Col md={8} sm={24} xs={24}>
              <h1 style={{ color: 'rgba(255,255,255,1)', fontSize: '50px', fontWeight: 'lighter', margin: '24px 10px' }}>{intl.get('title')}</h1>
            </Col>
            <Col md={8} sm={24} xs={24}>
              <a href="https://nimiq.skypool.org/" style={{ color: 'rgba(255,255,255,0.85)', fontSize: '20px', margin: '8px', textDecoration: 'none' }} target='_blank' rel="noopener noreferrer">
                {intl.get('linkTutorial')}
              </a>
              <a href="https://nimiq.skypool.org/" style={{ color: 'rgba(255,255,255,0.85)', fontSize: '20px', margin: '8px', textDecoration: 'none' }} target='_blank' rel="noopener noreferrer">
                {intl.get('linkPool')}
              </a>
              <a onClick={this.changeLanguage} style={{ color: 'rgba(255,255,255,0.85)', fontSize: '20px', margin: '8px', textDecoration: 'none' }} target='_blank' rel="noopener noreferrer">
                {intl.get('changeLanguage')}
              </a>
            </Col>
          </Row>
        </header>
        <Row type="flex" justify="center" align="bottom" gutter={24}>
          <Col lg={12} md={14} sm={22} xs={22}>
            <div className="Setting">
              <div className="Setting-title-default">
                <h3 style={{ color: 'rgba(255,255,255,0.85)', fontSize: '16px', margin: '0px', fontWeight: 'normal' }}>
                  {intl.get('settingTitle')}
                </h3>
              </div>
              <hr className="Setting-line"/>
              <div className="Setting-body">
                <Form>
                  <FormItem {...formItemLayout}
                    label={(
                      <span>
                        {intl.get('settingPoolNode')}&nbsp;
                        <Tooltip title={intl.get('settingTipPoolNode')}>
                          <Icon type="question-circle-o" />
                        </Tooltip>
                      </span>
                    )}>
                    <RadioGroup disabled={this.state.switch} defaultValue={this.state.server}
                      ref={(c) => this.serverComp = c}>
                      <RadioButton value="sh1">{intl.get('PoolNode-sh1')}</RadioButton>
                      <RadioButton value="hk1">{intl.get('PoolNode-hk1')}</RadioButton>
                      <RadioButton value="us1" disabled>{intl.get('PoolNode-us1')}</RadioButton>
                      <RadioButton value="eu1" disabled>{intl.get('PoolNode-eu1')}</RadioButton>
                    </RadioGroup>
                  </FormItem>
                  <FormItem {...formItemLayout}
                    label={(
                      <span>
                        {intl.get('settingAddress')}&nbsp;
                        <Tooltip title={intl.get('settingTipAddress')}>
                          <Icon type="question-circle-o" />
                        </Tooltip>
                      </span>
                    )}>
                    <Input disabled={this.state.switch} defaultValue={this.state.address} prefix={<Icon type="wallet" style={{ color: 'rgba(0,0,0,.25)' }} />}
                      ref={(c) => this.addressComp = c} />
                  </FormItem>
                  <FormItem {...formItemLayout}
                    label={(
                      <span>
                        {intl.get('settingName')}&nbsp;
                        <Tooltip title={intl.get('settingTipName')}>
                          <Icon type="question-circle-o" />
                        </Tooltip>
                      </span>
                    )}>
                    <Input disabled={this.state.switch} defaultValue={this.state.name} prefix={<Icon type="desktop" style={{ color: 'rgba(0,0,0,.25)' }} />}
                      ref={(c) => this.nameComp = c} />
                  </FormItem>
                  <FormItem {...formItemLayout}
                    label={(
                      <span>
                        {intl.get('settingThread')}&nbsp;
                        <Tooltip title={intl.get('settingTipThread')}>
                          <Icon type="question-circle-o" />
                        </Tooltip>
                      </span>
                    )}>
                    <Slider disabled={this.state.switch} defaultValue={this.state.thread} min={0} max={MaxThreads}
                      ref={(c) => this.threadComp = c} />
                  </FormItem>
                  <Switch size="large" checked={this.state.switch} onChange={this.switchMining.bind(this)} disabled={!this.state.isAbleMining} checkedChildren={intl.get('swtichStart')} unCheckedChildren={intl.get('swtichStop')} />
                </Form>
              </div>
            </div>
          </Col>
          <Col lg={6} md={8} sm={22} xs={22}>
            <StateCard miningState={this.state.miningState} hashrate={this.state.hashrate}
              miningTime={this.state.miningTime} />
          </Col>
        </Row>
        <Row type="flex" justify="center" align="top" gutter={24}>
          <Col lg={18} md={22} sm={22} xs={22}>
            <HashFig data={this.state.hashrateHistory}/>
          </Col>
        </Row>
      </div>
    );
  }
}

export default App;
