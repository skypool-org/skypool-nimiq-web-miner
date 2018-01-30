import React, { Component } from 'react';
import { Form, Input, Icon, Row, Col, Button, Tooltip, Radio } from 'antd';
import './StateCard.css';

const FormItem = Form.Item;
const RadioButton = Radio.Button;
const RadioGroup = Radio.Group;

class SettingCard extends React.Component {
  state = {
  };

  constructor(props) {
    super();
  }

  render() {
    const formItemLayout = {
      labelCol: {
        xs: { span: 8 },
        sm: { span: 8 },
      },
      wrapperCol: {
        xs: { span: 16 },
        sm: { span: 16 },
      },
    };

    let miningState = '待命中';
    let headStyle = 'StateCard-title-default';
    switch (this.props.miningState) {
      case 'default':
        miningState = '待命中';
        headStyle = 'StateCard-title-default';
        break;
      case 'disconnect':
        miningState = '连接断开，重试中';
        headStyle = 'StateCard-title-error';
        break;
      case 'registerFail':
        miningState = '请求失败，重试中';
        headStyle = 'StateCard-title-error';
        break;
      case 'serverUnable':
        miningState = '节点不可用，重试中';
        headStyle = 'StateCard-title-error';
        break;
      case 'serverFull':
        miningState = '节点矿机已满，重试中';
        headStyle = 'StateCard-title-error';
        break;
      case 'waitPulling':
        miningState = '网络不畅';
        headStyle = 'StateCard-title-warning';
        break;
      case 'mining':
        miningState = '挖矿中';
        headStyle = 'StateCard-title-success';
        break;        
    }

    return (
      <div className="StateCard">
        <div className={headStyle}>
          <h3 style={{ color: 'rgba(255,255,255,0.85)', fontSize: '16px', margin: '0px', fontWeight: 'normal' }}>
            {miningState}
          </h3>
        </div>
        <hr className="StateCard-line"/>
        <div className="StateCard-body">
          <Form>
            <FormItem {...formItemLayout}
              label={(
                <span><Icon type="rocket" /> 算力</span>
              )}>
              {(this.props.hashrate / 1000).toFixed(2)} KH/s
            </FormItem>
            <FormItem {...formItemLayout}
              label={(
                <span><Icon type="desktop" /> 线程数</span>
              )}>
              {this.props.thread}
            </FormItem>
            <FormItem {...formItemLayout}
              label={(
                <span><Icon type="clock-circle-o" /> 时长</span>
              )}>
              {[
                parseInt(this.props.miningTime / 3600000),
                parseInt(this.props.miningTime / 60000 % 60),
                parseInt(this.props.miningTime / 1000 % 60)
              ].join(":")
               .replace(/\b(\d)\b/g, "0$1")}
            </FormItem>
          </Form>
        </div>
      </div>
    );
  }
}

export default SettingCard;