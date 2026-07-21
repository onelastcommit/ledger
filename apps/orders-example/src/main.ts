import { InvalidTransitionError } from '@1percentlabs/ledger';
import { ledger, pool, setupReadModel } from './ledger.ts';
import { payOrder, placeOrder, shipOrder } from './orders.service.ts';

const customer = { kind: 'user', id: 'customer-42', role: 'buyer' } as const;
const payments = { kind: 'service', id: 'payments-worker' } as const;
const warehouse = { kind: 'service', id: 'warehouse' } as const;

const main = async (): Promise<void> => {
  await ledger.migrate();
  await setupReadModel();

  const shipped: string[] = [];
  const notifier = ledger.subscribe({
    name: 'shipping-notifier',
    streamTypes: ['order'],
    pollIntervalMs: 200,
    onEvent: (event) => {
      if (event.type === 'OrderShipped') shipped.push(event.streamId);
    },
  });
  await notifier.caughtUp();

  const orderId = `order:${Date.now()}`;

  await placeOrder(orderId, 4999, customer);
  await payOrder(orderId, payments);
  await shipOrder(orderId, warehouse);

  console.log('state       ', await ledger.getState(orderId));

  const summary = await pool.query(
    'SELECT status, updated_seq FROM order_summary WHERE order_id = $1',
    [orderId],
  );
  console.log('read model  ', summary.rows[0]);

  console.log('audit trail ');
  for (const event of await ledger.readStream(orderId)) {
    const who =
      event.actor.kind === 'user'
        ? `user ${event.actor.id}`
        : event.actor.kind === 'service'
          ? `service ${event.actor.id}`
          : event.actor.kind;
    console.log(
      `   seq ${event.seq}  ${event.type.padEnd(14)} by ${who.padEnd(24)} at ${event.occurredAt}`,
    );
  }

  console.log('tamper check', await ledger.verifyStream(orderId));

  try {
    await shipOrder(orderId, warehouse);
  } catch (error) {
    console.log(
      're-ship     ',
      (error as Error).constructor.name,
      '->',
      error instanceof InvalidTransitionError,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  console.log('subscriber  ', `notified for ${shipped.length} shipment(s):`, shipped);

  await notifier.stop();
  await pool.end();
};

await main();
