// Shared ONVIF pull-point event helper.
//
// Several analytics ACAPs (AOA, LPV, VMD4, ...) only expose their live
// trigger/alarm state through the VAPIX/ONVIF event stream — there is no
// polling CGI. A stateful event topic reports its current value immediately
// when a client subscribes (no need to wait for a state change), so a
// short-lived pull-point subscription doubles as a one-shot "read current
// state" call: CreatePullPointSubscription -> PullMessages -> Unsubscribe
// (best-effort), all over the same /vapix/services SOAP endpoint already used
// by list_event_declarations.
import { vapix } from '../vapix';

const EVENTS_NS = 'http://www.onvif.org/ver10/events/wsdl';

function createPullPointBody(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <CreatePullPointSubscription xmlns="${EVENTS_NS}">
      <InitialTerminationTime>PT30S</InitialTerminationTime>
    </CreatePullPointSubscription>
  </soap:Body>
</soap:Envelope>`;
}

function pullMessagesBody(timeoutSeconds: number, messageLimit: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <PullMessages xmlns="${EVENTS_NS}">
      <Timeout>PT${timeoutSeconds}S</Timeout>
      <MessageLimit>${messageLimit}</MessageLimit>
    </PullMessages>
  </soap:Body>
</soap:Envelope>`;
}

const UNSUBSCRIBE_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>
  </soap:Body>
</soap:Envelope>`;

function extractTagText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`));
  return m ? m[1].trim() : undefined;
}

/** The subscription reference address is host-relative on Axis cameras; fall back to /vapix/services if it can't be parsed. */
function extractSubscriptionPath(xml: string): string {
  const address = extractTagText(xml, 'Address');
  if (!address) return '/vapix/services';
  try {
    const u = new URL(address);
    return u.pathname + u.search;
  } catch {
    return '/vapix/services';
  }
}

export interface NotificationBlock {
  topic: string;
  items: Record<string, string>;
}

function parseNotifications(xml: string): NotificationBlock[] {
  const blocks = xml.match(/<(?:[\w-]+:)?NotificationMessage[\s\S]*?<\/(?:[\w-]+:)?NotificationMessage>/g) || [];
  return blocks.map((block) => {
    const topic = (extractTagText(block, 'Topic') || '').replace(/^tns\d*:/, '');
    const items: Record<string, string> = {};
    const itemRe = /<(?:[\w-]+:)?SimpleItem\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(block)) !== null) {
      const attrs = m[1];
      const name = attrs.match(/Name="([^"]*)"/)?.[1];
      const value = attrs.match(/Value="([^"]*)"/)?.[1];
      if (name !== undefined) items[name] = value ?? '';
    }
    return { topic, items };
  });
}

export class EventPullError extends Error {
  constructor(public stage: 'subscribe' | 'pull', public status: number, public bodyExcerpt: string) {
    super(`Event pull-point ${stage} failed (HTTP ${status}): ${bodyExcerpt.slice(0, 300)}`);
    this.name = 'EventPullError';
  }
}

/**
 * Open a short-lived pull-point subscription, read whatever is queued, and
 * tear it back down. Returns every notification seen — callers filter by
 * topic for the ACAP they care about (e.g. /ObjectAnalytics/i).
 */
export async function pullCurrentEvents(
  opts: { timeoutSeconds?: number; messageLimit?: number } = {},
): Promise<NotificationBlock[]> {
  const { timeoutSeconds = 3, messageLimit = 1024 } = opts;

  const subRes = await vapix({
    method: 'POST',
    path: '/vapix/services',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: createPullPointBody(),
  });
  if (subRes.status < 200 || subRes.status >= 300) {
    throw new EventPullError('subscribe', subRes.status, subRes.text());
  }
  const pullPath = extractSubscriptionPath(subRes.text());

  const pullRes = await vapix({
    method: 'POST',
    path: pullPath,
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: pullMessagesBody(timeoutSeconds, messageLimit),
  });

  // Best-effort teardown — a failed Unsubscribe shouldn't affect the result
  // (the subscription simply expires after its InitialTerminationTime).
  vapix({
    method: 'POST',
    path: pullPath,
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: UNSUBSCRIBE_BODY,
  }).catch(() => {});

  if (pullRes.status < 200 || pullRes.status >= 300) {
    throw new EventPullError('pull', pullRes.status, pullRes.text());
  }

  return parseNotifications(pullRes.text());
}
