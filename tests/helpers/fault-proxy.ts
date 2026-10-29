import net from 'node:net';

/**
 * Tiny TCP proxy used for network fault injection between gateways and Redis.
 *   sever()      -> RST every open connection and refuse new ones (Redis process died / SG changed)
 *   heal()       -> accept again
 *   blackhole(b) -> keep sockets open but silently drop all bytes (half-open link, e.g. NLB idle drop / AZ partition)
 *   latency(ms)  -> delay every chunk
 */
export class FaultProxy {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private refusing = false;
  private blackholed = false;
  private delayMs = 0;
  port = 0;

  constructor(private targetPort: number, private targetHost = '127.0.0.1') {
    this.server = net.createServer((client) => this.onClient(client));
  }

  async start(): Promise<this> {
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  private onClient(client: net.Socket) {
    if (this.refusing) return void client.destroy();
    const up = net.connect(this.targetPort, this.targetHost);
    this.sockets.add(client).add(up);
    // Per-direction release clock keeps byte ORDER intact when latency changes (TCP never reorders; a naive setTimeout would).
    const fwd = (from: net.Socket, to: net.Socket) => {
      let lastAt = 0;
      from.on('data', (d) => {
        if (this.blackholed) return;
        const now = Date.now();
        const at = Math.max(now + this.delayMs, lastAt);
        lastAt = at;
        if (at <= now) to.write(d);
        else setTimeout(() => to.writable && to.write(d), at - now);
      });
    };
    fwd(client, up);
    fwd(up, client);
    const kill = () => {
      client.destroy();
      up.destroy();
      this.sockets.delete(client);
      this.sockets.delete(up);
    };
    client.on('error', kill).on('close', kill);
    up.on('error', kill).on('close', kill);
  }

  sever() {
    this.refusing = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
  heal() {
    this.refusing = false;
    this.blackholed = false;
    this.delayMs = 0;
  }
  blackhole(on: boolean) {
    this.blackholed = on;
  }
  latency(ms: number) {
    this.delayMs = ms;
  }
  async stop() {
    this.sever();
    await new Promise<void>((res) => this.server.close(() => res()));
  }
}
