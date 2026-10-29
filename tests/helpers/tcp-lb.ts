import net from 'node:net';

/**
 * Minimal L4 round-robin load balancer: the local stand-in for an AWS Network Load Balancer.
 * Like an NLB it is protocol-agnostic (WebSocket upgrade passes straight through) and skips targets that refuse connections.
 */
export class TcpLb {
  private server: net.Server;
  private rr = 0;
  port = 0;
  constructor(public backends: number[]) {
    this.server = net.createServer((c) => this.route(c));
  }
  async start(): Promise<this> {
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  remove(port: number) {
    this.backends = this.backends.filter((p) => p !== port);
  }
  add(port: number) {
    if (!this.backends.includes(port)) this.backends.push(port);
  }
  private route(client: net.Socket, tried = 0) {
    if (this.backends.length === 0 || tried >= this.backends.length) return void client.destroy();
    const target = this.backends[this.rr++ % this.backends.length];
    const up = net.connect(target, '127.0.0.1');
    up.once('connect', () => {
      client.pipe(up);
      up.pipe(client);
    });
    up.once('error', () => this.route(client, tried + 1));
    client.on('error', () => up.destroy());
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());
  }
  async stop() {
    await new Promise<void>((res) => this.server.close(() => res()));
  }
}
