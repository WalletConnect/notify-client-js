// Polls boolean value every interval to check for an event callback having been triggered.
export const waitForEvent = async (
  checkForEvent: (...args: any[]) => boolean
) => {
  await new Promise((resolve) => {
    const intervalId = setInterval(() => {
      if (checkForEvent()) {
        clearInterval(intervalId);
        resolve({});
      }
    }, 100);
  });
};
