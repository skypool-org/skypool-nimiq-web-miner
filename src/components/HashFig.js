import React, { Component } from 'react';
import { Chart, Geom, Axis, Tooltip, G2 } from 'bizcharts';
import intl from 'react-intl-universal';
import './HashFig.css';

class HashFig extends Component {

  constructor(props) {
    super();
    G2.track(false);
  }

  render() {
    const scale={
      time: {
      },
      hashrate: {
        type:"linear",
      },
    };

    return (
      <div className="HashFig">
        <div className="HashFig-title-default">
          <h3 style={{ color: 'rgba(255,255,255,0.85)', fontSize: '16px', margin: '0px', fontWeight: 'normal' }}>
            {intl.get('hashFigTitle')}
          </h3>
        </div>
        <hr className="HashFig-line"/>
        <div className="HashFig-body">
          <Chart height={400} data={this.props.data} scale={scale} padding={[ 30, 80, 50, 80]} forceFit>
            <Axis name="time" label={{
              formatter: val => {
                return new Date(parseInt(val, 10)).toLocaleTimeString();
              }
            }}/>
            <Axis name="hashrate" label={{
              formatter: val => {
                return (val / 1000).toFixed(2) + ' KH/s';
              }
            }} />
            <Tooltip crosshairs={{ type: 'cross' }}/>
            <Geom type="area" position="time*hashrate" color={['hashrate', '#722ed1']}
              tooltip={['time*hashrate', (time, hashrate) => {
                return {
                    //自定义 tooltip 上显示的 title 显示内容等。
                  name: intl.get('hashFigHashrate'),
                  title: new Date(time).toLocaleTimeString(),
                  value: (hashrate / 1000).toFixed(2) + ' KH/s',
                };
              }]}/>
            <Geom type="line" position="time*hashrate" size={2} color='#722ed1' />
          </Chart>
        </div>
      </div>
    );
  }
}

export default HashFig;
