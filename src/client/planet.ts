// What stands in for the sun in the room. The saved one is applied before first paint by public/js/boot.js.
export const PLANETS = [
    ['sun', 'Sun'], ['moon', 'Moon'], ['mercury', 'Mercury'], ['venus', 'Venus'], ['earth', 'Earth'],
    ['mars', 'Mars'], ['jupiter', 'Jupiter'], ['saturn', 'Saturn'], ['uranus', 'Uranus'], ['neptune', 'Neptune']
] as const;
export type Planet = typeof PLANETS[number][0];
const IDS: readonly string[] = PLANETS.map(([id]) => id);

export function currentPlanet(): Planet {
    const saved = document.documentElement.dataset.planet as Planet;
    return IDS.includes(saved) ? saved : 'sun';
}

export function setPlanet(planet: Planet) {
    document.documentElement.dataset.planet = planet;
    try { localStorage.setItem('flow_planet', planet); } catch { /* Private mode: applies for this page only. */ }
}

export function bindPlanetPicker(picker: HTMLSelectElement) {
    picker.value = currentPlanet();
    picker.addEventListener('change', () => setPlanet(picker.value as Planet));
}
