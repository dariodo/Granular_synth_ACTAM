class GrainSchedulerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastTime = 0;
    this.intervalSec = 0.1; 
    this.port.onmessage = (e) => {
      if (e.data.type === 'updateInterval') {
        this.intervalSec = e.data.interval;
        this.lastTime = currentTime;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const now = currentTime;
    if (now - this.lastTime >= this.intervalSec) {
      this.port.postMessage({ type: 'triggerGrain', time: now });
      this.lastTime = now;
    }
    return true;
  }
}

registerProcessor('grain-scheduler-processor', GrainSchedulerProcessor);