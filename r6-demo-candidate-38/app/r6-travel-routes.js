export function knownAdjacentTravelRoutes(routes, character) {
  const knownLocations = new Set(character?.knownLocations || []);
  return routes.filter((route) => route.from === character?.location && knownLocations.has(route.to));
}
