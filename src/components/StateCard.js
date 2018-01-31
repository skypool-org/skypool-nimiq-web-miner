import React from 'react';
import { Icon } from 'antd';
import intl from 'react-intl-universal';
import './StateCard.css';

class SettingCard extends React.Component {
  state = {
  };

  constructor(props) {
    super();
  }

  render() {
    let miningState = intl.get('stateTitleDefault');
    let headStyle = 'StateCard-title-default';
    switch (this.props.miningState) {
      case 'default':
        miningState = intl.get('stateTitleDefault');
        headStyle = 'StateCard-title-default';
        break;
      case 'disconnect':
        miningState = intl.get('stateTitleDisconnect');
        headStyle = 'StateCard-title-error';
        break;
      case 'registerFail':
        miningState = intl.get('stateTitleRegisterFail');
        headStyle = 'StateCard-title-error';
        break;
      case 'serverUnable':
        miningState = intl.get('stateTitleServerUnable');
        headStyle = 'StateCard-title-error';
        break;
      case 'serverFull':
        miningState = intl.get('stateTitleServerFull');
        headStyle = 'StateCard-title-error';
        break;
      case 'waitPulling':
        miningState = intl.get('stateTitleWaitPulling');
        headStyle = 'StateCard-title-warning';
        break;
      case 'mining':
        miningState = intl.get('stateTitleMining');
        headStyle = 'StateCard-title-success';
        break;
      default:
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
          <div style={{ fontSize: '24px', color: 'rgba(0,0,0,0.8)', padding: '8px' }}>
            <span style={{ fontSize: '16px', color: 'rgba(0,0,0,0.8)'}}>
              <Icon type="rocket" /> {intl.get('stateHashrate')}
            </span>
            {(this.props.hashrate / 1000).toFixed(2)} KH/s
          </div>
          <hr className="StateCard-line"/>
          <div style={{ fontSize: '24px', color: 'rgba(0,0,0,0.8)', padding: '8px' }}>
            <span style={{ fontSize: '16px', color: 'rgba(0,0,0,0.8)'}}>
              <Icon type="clock-circle-o" /> {intl.get('stateTime')}</span>
              {[
                parseInt(this.props.miningTime / 3600000, 10),
                parseInt(this.props.miningTime / 60000 % 60, 10),
                parseInt(this.props.miningTime / 1000 % 60, 10)
              ].join(":").replace(/\b(\d)\b/g, "0$1")}
          </div>
        </div>
      </div>
    );
  }
}

export default SettingCard;