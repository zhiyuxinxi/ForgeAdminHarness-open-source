// Operator entrypoint and runtime projection deliberately share the same pure
// implementation; no business documents or stage receipts are modified.
export { generateExplicitDiagrams, extractExplicitFlowChains, extractNamedEntityRelations,
  enrichDeliveryPacketDiagrams } from '../docker/harness/delivery-center-diagrams.mjs';
