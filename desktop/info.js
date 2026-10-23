// Text for info tiles: clock, timers, OBS stats, PC load, countdown.
const os = require('os');

const pad = (n) => String(n).padStart(2, '0');

function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

class Info {
  constructor(obs) {
    this.obs = obs;
    this.lastCpu = null;
  }

  // CPU use since the previous call, 0-100.
  cpuPercent() {
    const now = os.cpus().reduce((a, c) => {
      const t = Object.values(c.times).reduce((x, y) => x + y, 0);
      return { idle: a.idle + c.times.idle, total: a.total + t };
    }, { idle: 0, total: 0 });
    const prev = this.lastCpu;
    this.lastCpu = now;
    if (!prev || now.total === prev.total) return 0;
    return Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 100);
  }

  async text(w) {
    switch (w.source) {
      case 'clock':
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      case 'clocksec':
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      case 'date':
        return new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      case 'rec':
        if (!this.obs.connected || !this.obs.state.recording) return '--:--';
        return hms((await this.obs.call('GetRecordStatus')).outputDuration);
      case 'stream':
        if (!this.obs.connected || !this.obs.state.streaming) return '--:--';
        return hms((await this.obs.call('GetStreamStatus')).outputDuration);
      case 'obsstats': {
        if (!this.obs.connected) return 'OBS\noffline';
        const s = await this.obs.call('GetStats');
        return `${Math.round(s.activeFps)} fps\n${Math.round(s.cpuUsage)}% CPU`;
      }
      case 'cpu':
        return `${this.cpuPercent()}%`;
      case 'ram':
        return `${Math.round((1 - os.freemem() / os.totalmem()) * 100)}%`;
      case 'countdown': {
        const until = Date.parse(w.until);
        if (Number.isNaN(until)) return 'set a time';
        const left = until - Date.now();
        if (left <= 0) return 'now!';
        const days = Math.floor(left / 86400000);
        return days ? `${days}d ${hms(left % 86400000)}` : hms(left);
      }
      default:
        return '';
    }
  }
}

module.exports = { Info, hms };
