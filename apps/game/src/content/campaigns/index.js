// Campaign descriptors. A campaign just picks a character + map; the campaign
// RULES (wave count, shops, headshots, shop weapons) live in BALANCE.campaign,
// since for now there is a single campaign. Add more here as they appear.
export const duck = {
  id: 'duck',
  name: 'Pato',
  character: 'duck',
  map: 'meadow',
  note: 'Solo pistola · 20 oleadas · tienda cada 5',
};

export const CAMPAIGNS = [duck];

export function getCampaign(id) {
  return CAMPAIGNS.find((c) => c.id === id) ?? CAMPAIGNS[0];
}

export default CAMPAIGNS;
