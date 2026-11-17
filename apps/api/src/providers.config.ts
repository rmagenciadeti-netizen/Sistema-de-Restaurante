// Register real provider adapters here, for example:
//   import { paymentProviders } from './lib/providers';
//   paymentProviders.register(new MyPixGateway(process.env.PIX_API_KEY!));
// The API never fakes a charge or a tax document: while a registry is empty the related endpoints answer 501.
export function registerProviders() {
  // No adapter is bundled.
}
