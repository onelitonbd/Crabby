// §13's tunnel, as the wire sees it: the enable/disable pair, with the body carrying the T3 confirmation the
// interfaces' approval text ends in. The answer names the URL (§13: discovered, printed, never assumed) and the
// paired identities that just became remotely reachable — the sentence §13 requires the enabling surface to say.

import { type Static, Type } from "@sinclair/typebox";

export const TunnelBody = Type.Object(
  {
    /** §13: enabling is T3. The client's confirmation is the flag — a CLI sends it after its own prompt (which
     *  printed the reachable identities), and a body without it is refused before anything spawns. */
    confirm: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const TunnelReachableIdentity = Type.Object(
  { name: Type.String(), interface: Type.String() },
  { additionalProperties: false },
);

export const TunnelAnswer = Type.Object(
  {
    url: Type.String({ pattern: "^https://" }),
    reachable: Type.Array(TunnelReachableIdentity),
  },
  { additionalProperties: false },
);

export const TunnelStopAnswer = Type.Object(
  { stopped: Type.Literal(true) },
  { additionalProperties: false },
);

export type TunnelBodyT = Static<typeof TunnelBody>;
export type TunnelAnswerT = Static<typeof TunnelAnswer>;
export type TunnelStopAnswerT = Static<typeof TunnelStopAnswer>;
