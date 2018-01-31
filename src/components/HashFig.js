import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import { Chart, Geom, Axis, Tooltip, Legend, Coord } from 'bizcharts';
import './HashFig.css';

class HashFig extends Component {

  constructor(props) {
    super();
  }

  render() {
    const data = [
      { time: new Date().getTime() - 9000, hashrate: 1468 },
      { time: new Date().getTime() - 8000, hashrate: 1468 },
      { time: new Date().getTime() - 7000, hashrate: 3468 },
      { time: new Date().getTime() - 6000, hashrate: 2468 },
      { time: new Date().getTime() - 5000, hashrate: 468 },
      { time: new Date().getTime() - 4000, hashrate: 1468 },
      { time: new Date().getTime() - 3000, hashrate: 15468 },
      { time: new Date().getTime() - 2000, hashrate: 16100 },
      { time: new Date().getTime() - 1000, hashrate: 14100 },
      { time: new Date().getTime(), hashrate: 14100 },
      { time: new Date().getTime() + 1000, hashrate: 14100 },

    ];
    const scale={
      time: {
      },
      hashrate: {
        type:"linear",
      },
    };

    // 渲染图表
    return (
      <div className="HashFig">
        <div className="HashFig-title-default">
          <h3 style={{ color: 'rgba(255,255,255,0.85)', fontSize: '16px', margin: '0px', fontWeight: 'normal' }}>
            算力时间图
          </h3>
        </div>
        <hr className="HashFig-line"/>
        <div className="HashFig-body">
          <Chart height={400} data={this.props.data} scale={scale} padding={[ 30, 80, 50, 80]} forceFit>
            <Axis name="time" label={{
              formatter: val => {
                return new Date(parseInt(val)).toLocaleTimeString();
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
                  name: '算力',
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
