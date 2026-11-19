// Kind of client a session was started from, decided at sign-in from the request's User-Agent and then carried in the signed token (it cannot be changed afterwards).
// The official cash closing is only allowed to DESKTOP sessions: a computer running the RM Restaurant web app. Card terminals, phones/tablets and scripts calling the API directly are not.
export type ClientKind = 'DESKTOP' | 'DEVICE' | 'API';
const DEVICE = /android|iphone|ipad|ipod|mobile|tablet|silk|kindle|pos\b|pinpad|smartpos|sunmi|pax|gertec|ingenico|verifone|stone|cielo|rede\b|getnet|pagseguro|moderninha|minizinha|ton\b/i;
export function clientKindOf(userAgent: string | undefined): ClientKind {
  const agent = (userAgent ?? '').trim();
  if (!/^Mozilla\/\d/.test(agent)) return 'API';
  return DEVICE.test(agent) ? 'DEVICE' : 'DESKTOP';
}
