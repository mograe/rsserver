let stopwatch = {
    startTime: null,
    elapsedTime: 0,
    running: false,
    interval: null
  };
  
function startStopwatch() {
    if (!stopwatch.running) {
      stopwatch.running = true;
      stopwatch.startTime = Date.now() - stopwatch.elapsedTime;
      stopwatch.interval = setInterval(() => {
        stopwatch.elapsedTime = Date.now() - stopwatch.startTime;
      }, 1000);
    }
  }
  
  function stopStopwatch() {
    if (stopwatch.running) {
      stopwatch.running = false;
      clearInterval(stopwatch.interval);
    }
  }
  
  function resetStopwatch() {
    stopStopwatch();
    stopwatch.elapsedTime = 0;
  }

  function getElapsedTime() {
    return stopwatch.elapsedTime;
  }

  module.exports = {
    startStopwatch,
    stopStopwatch,
    resetStopwatch,
    getElapsedTime
  }