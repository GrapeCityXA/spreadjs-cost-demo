function precheckSnapshotVersion(snapshot, roomVersion) {
  const currentRoomVersion = Number(roomVersion || 0);
  const snapshotUnavailable = !snapshot && currentRoomVersion > 0;
  const snapshotVersion = Number.isSafeInteger(Number(snapshot?.v)) ? Number(snapshot.v) : currentRoomVersion;
  return {
    version: snapshotVersion,
    roomVersion: currentRoomVersion,
    snapshotUnavailable,
    stale: snapshotUnavailable || snapshotVersion !== currentRoomVersion
  };
}

module.exports = { precheckSnapshotVersion };
