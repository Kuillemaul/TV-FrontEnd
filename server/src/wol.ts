import { createSocket } from 'node:dgram';

/** Send a Wake-on-LAN magic packet to the given MAC address. */
export function wake(mac: string, address = '255.255.255.255', port = 9): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error(`Invalid MAC address: ${mac}`));
  const target = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) target.copy(packet, 6 + i * 6);

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
