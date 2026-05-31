// The uniform enemy contract. One object that fans combat and status effects
// out to every enemy manager, so Weapons and MageController act on all enemy
// types without ever importing a concrete manager. This is the load-bearing
// seam of gameplay modularity — keep its shape stable.
//
// Contract: hitMelee/hitBox/hitByRay/hitAllByRay/knockback/slow/heal/
// tornadoPull/anyNear/aliveCount (+ the raw `managers` list).
export function createEnemyAggregator({ dragons, zombies, skeletons, witches, world }) {
  const managers = [dragons, zombies, skeletons, witches];
  const lists = () => [dragons.dragons, zombies.zombies, skeletons.skeletons, witches.witches];

  return {
    managers,
    hitMelee: (o, d, r, dmg, arc) => managers.flatMap((m) => m.hitMelee(o, d, r, dmg, arc)),
    hitBox: (o, f, ri, l, hw, dmg) => managers.flatMap((m) => m.hitBox(o, f, ri, l, hw, dmg)),
    knockback: (c, r, f) => managers.forEach((m) => m.knockback(c, r, f, world)),
    slow: (c, r, fac, dur) => managers.forEach((m) => m.slow(c, r, fac, dur)),
    // Only the ground mobs are liftable by the fire tornado (dragons fly).
    tornadoPull: (c, r, e) => { zombies.tornadoPull(c, r, e); skeletons.tornadoPull(c, r, e); witches.tornadoPull(c, r, e); },
    heal: (c, r, amount) => managers.forEach((m) => m.heal(c, r, amount)),
    hitAllByRay: (ray, dmg) => managers.flatMap((m) => m.hitAllByRay(ray, dmg)),
    hitByRay: (ray, dmg) => {
      let best = null;
      let bestMgr = null;
      for (const m of managers) {
        const peek = m.peekRay(ray);
        if (peek && (!best || peek.distance < best.distance)) { best = peek; bestMgr = m; }
      }
      return best ? bestMgr.applyRayHit(best, dmg) : null;
    },
    anyNear: (pos, radius) => lists().some((list) => list.some((e) => !e.dead && pos.distanceTo(e.mesh.position) < radius)),
    aliveCount: () => managers.reduce((sum, m) => sum + m.getAliveCount(), 0),
  };
}

export default createEnemyAggregator;
