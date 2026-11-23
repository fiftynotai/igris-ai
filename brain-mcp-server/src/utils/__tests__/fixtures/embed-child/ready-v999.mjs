// TD-525 fixture child ENTRY (EC15): answers with a protocol version the client does not speak.
process.on('message', () => {});
process.send({ ready: 1, v: 999 });
