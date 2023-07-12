process.on("unhandledRejection", (reason: any, promise) => {
  // eslint-disable-next-line no-console
  console.log(`FAILED TO HANDLE PROMISE REJECTION`, promise, reason);
});
