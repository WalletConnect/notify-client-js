const getCaip10FromDidPkh = (didPkh: string) => {
  return didPkh.split(":").slice(-3).join(":");
};
