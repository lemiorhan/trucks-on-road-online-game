'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR, U = TR.U;

  // Local coordinates: origin at the lot entrance (the end of the road), y grows downwards.
  // The gate is a little wider than the road's rails, so a truck scraping a rail does not
  // catch the wall end on its way in.
  const W = 560, H = 920, WALL = 26, GAP = TR.ROAD.RAIL + 10;
  const BAY_W = 72, BAY_D = 220, BAY_X = 95;
  const WH_TOP = -1330;
  const ANGLE_TOL = 7, REAR_TOL = 22, STOP_TOL = 8;
  const LATERAL_MAX = BAY_W / 2 - TR.TRUCK.TR_HW;
  // A solo round leaves bay 2 and its door to nobody.
  const UNOWNED = { color: '#78909c', phase: 'race' };
  const owner = (players, k) => players[k] || UNOWNED;
  TR.LOT = { W, H, WALL, GAP, BAY_W, BAY_D, BAY_X, WH_TOP, ANGLE_TOL, REAR_TOL, STOP_TOL, LATERAL_MAX };

  class Lot {
    constructor(ox, oy) {
      this.ox = ox;
      this.oy = oy;
      const A = (x0, y0, x1, y1) => ({ x0: ox + x0, y0: oy + y0, x1: ox + x1, y1: oy + y1 });
      this.walls = [
        A(-W - WALL, 0, -GAP, WALL),
        A(GAP, 0, W + WALL, WALL),
        A(-W - WALL, -H - WALL, -W, WALL),
        A(W, -H - WALL, W + WALL, WALL),
        A(-W - WALL, -H - WALL, W + WALL, -H),
      ];
      this.wallBoxes = this.walls.map((r) => U.aabb(r.x0, r.y0, r.x1, r.y1));
      this.props = [
        { kind: 'trailer', x: ox - 480, y: oy - 560, a: Math.PI / 2, hl: 66, hw: 18, color: '#7d8a96' },
        { kind: 'trailer', x: ox + 482, y: oy - 430, a: -Math.PI / 2, hl: 66, hw: 18, color: '#9b8b6e' },
        { kind: 'booth', x: ox - 250, y: oy - 70, a: 0, hl: 26, hw: 20 },
        { kind: 'pole', x: ox, y: oy - 470, a: 0, hl: 9, hw: 9 },
      ];
      this.propBoxes = this.props.map((p) => U.obb(p.x, p.y, p.hl, p.hw, p.a));
      this.bays = [-1, 1].map((side, idx) => {
        const cx = ox + side * BAY_X;
        return { idx, cx, x0: cx - BAY_W / 2, x1: cx + BAY_W / 2, y0: oy - H, y1: oy - H + BAY_D };
      });
      this.doors = this.bays.map((b) => ({ x: b.cx, y: oy - H - WALL / 2 }));
      this.warehouse = A(-W - WALL, WH_TOP, W + WALL, -H - WALL);
      this.bounds = A(-W - WALL, WH_TOP, W + WALL, WALL);
      this.floors = [
        A(-W + 4, WH_TOP + 54, -18, -H - WALL - 10),
        A(18, WH_TOP + 54, W - 4, -H - WALL - 10),
      ];
      this.zoneCenters = [{ x: ox - 390, y: oy - 1180 }, { x: ox + 390, y: oy - 1180 }];
    }

    contains(x, y) {
      const b = this.bounds;
      return x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
    }

    entrance() {
      return { x: this.ox + 60, y: this.oy - 120, th: -Math.PI / 2 };
    }

    // Pushes the truck out of walls and parked props. Returns true on contact.
    collideTruck(truck) {
      if (truck.y > this.oy + 260) return false;
      let hit = false;
      const solids = this.wallBoxes.concat(this.propBoxes);
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (const tb of truck.boxes()) {
          for (const s of solids) {
            const m = U.sat(tb, s);
            if (!m) continue;
            truck.x -= m.nx * (m.depth + 0.05);
            truck.y -= m.ny * (m.depth + 0.05);
            moved = true;
            hit = true;
          }
        }
        if (!moved) break;
      }
      if (hit) truck.v = 0;
      return hit;
    }

    parkStatus(truck, idx) {
      const bay = this.bays[idx];
      const corners = U.corners(truck.trailerBox());
      const inside = corners.every((p) => p.x >= bay.x0 - 1 && p.x <= bay.x1 + 1 && p.y >= bay.y0 - 3 && p.y <= bay.y1);
      const rear = truck.trailerRear();
      const rearDist = Math.max(0, rear.y - bay.y0);
      const angleErr = (Math.abs(U.wrap(truck.phi - Math.PI / 2)) * 180) / Math.PI;
      const lateral = rear.x - bay.cx;
      const near = Math.hypot(rear.x - bay.cx, rear.y - (bay.y0 + BAY_D / 2)) < 420;
      const ok = inside && rearDist < REAR_TOL && angleErr < ANGLE_TOL && Math.abs(truck.v) < STOP_TOL;
      return { inside, rearDist, angleErr, lateral, near, ok };
    }

    // ---------- drawing ----------
    draw(ctx, view, players) {
      if (view.y1 < this.oy + WH_TOP - 50 || view.y0 > this.oy + 300) return;
      const ox = this.ox, oy = this.oy;
      ctx.fillStyle = '#585c61';
      ctx.fillRect(ox - W, oy - H, W * 2, H);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      for (let gx = -W; gx < W; gx += 80) ctx.fillRect(ox + gx, oy - H, 2, H);
      for (let gy = -H; gy < 0; gy += 80) ctx.fillRect(ox - W, oy + gy, W * 2, 2);

      ctx.fillStyle = '#44474c';
      ctx.fillRect(ox - GAP, oy - 10, GAP * 2, WALL + 30);
      this.drawMarkings(ctx, players);
      this.drawWarehouse(ctx, players);
      for (const r of this.walls) {
        ctx.fillStyle = '#a3a6a9';
        ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        ctx.strokeStyle = '#6f7275';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x0 + 1, r.y0 + 1, r.x1 - r.x0 - 2, r.y1 - r.y0 - 2);
      }
      this.drawDoors(ctx, players);
      for (const p of this.props) drawProp(ctx, p);
    }

    drawMarkings(ctx, players) {
      const ox = this.ox, oy = this.oy;
      ctx.save();
      ctx.strokeStyle = '#f0c419';
      ctx.lineWidth = 3;
      ctx.setLineDash([18, 14]);
      ctx.beginPath();
      ctx.moveTo(ox, oy - 10);
      ctx.lineTo(ox, oy - 400);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GİRİŞ', ox + 80, oy - 30);
      ctx.fillText('PARK ALANI', ox, oy - 620);
      for (const b of this.bays) {
        const col = owner(players, b.idx).color;
        ctx.fillStyle = U.shade(col, -0.55);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(b.x0, b.y0, BAY_W, BAY_D);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y1);
        ctx.lineTo(b.x0, b.y0);
        ctx.moveTo(b.x1, b.y0);
        ctx.lineTo(b.x1, b.y1);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 10]);
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y1);
        ctx.lineTo(b.x1, b.y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b.cx, b.y0 + 30);
        ctx.lineTo(b.cx, b.y1 + 160);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.font = 'bold 34px system-ui, sans-serif';
        ctx.fillText(String(b.idx + 1), b.cx, b.y1 + 44);
        ctx.fillStyle = '#111';
        ctx.fillRect(b.x0 + 8, b.y0, 12, 6);
        ctx.fillRect(b.x1 - 20, b.y0, 12, 6);
      }
      ctx.restore();
    }

    drawDoors(ctx, players) {
      for (const d of this.doors) {
        const idx = this.doors.indexOf(d);
        const q = owner(players, idx), open = q.phase === 'unload' || q.phase === 'done';
        ctx.fillStyle = open ? '#2a2d31' : U.shade(q.color, -0.2);
        ctx.fillRect(d.x - 26, d.y - WALL / 2, 52, WALL);
        if (!open) {
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1;
          for (let x = -22; x <= 22; x += 6) {
            ctx.beginPath();
            ctx.moveTo(d.x + x, d.y - WALL / 2 + 2);
            ctx.lineTo(d.x + x, d.y + WALL / 2 - 2);
            ctx.stroke();
          }
        }
      }
    }

    drawWarehouse(ctx, players) {
      const r = this.warehouse;
      ctx.fillStyle = '#cfcac0';
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 1;
      for (let x = r.x0; x < r.x1; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, r.y0); ctx.lineTo(x, r.y1); ctx.stroke();
      }
      for (let y = r.y0; y < r.y1; y += 40) {
        ctx.beginPath(); ctx.moveTo(r.x0, y); ctx.lineTo(r.x1, y); ctx.stroke();
      }
      ctx.fillStyle = '#8d9196';
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, 20);
      ctx.fillRect(r.x0, r.y0, 20, r.y1 - r.y0);
      ctx.fillRect(r.x1 - 20, r.y0, 20, r.y1 - r.y0);
      ctx.fillRect(this.ox - 8, r.y0, 16, r.y1 - r.y0);
      for (let k = 0; k < 2; k++) {
        const fl = this.floors[k];
        for (let x = fl.x0 + 30; x < fl.x1 - 60; x += 110) {
          if (Math.abs(x + 25 - this.zoneCenters[k].x) < 170) continue;
          ctx.fillStyle = '#7a5b3a';
          ctx.fillRect(x, r.y0 + 22, 70, 22);
          ctx.fillStyle = '#b8874f';
          for (let j = 0; j < 3; j++) ctx.fillRect(x + 4 + j * 22, r.y0 + 25, 18, 16);
        }
        const z = this.zoneCenters[k];
        ctx.fillStyle = owner(players, k).color;
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('HEDEF ALAN ' + (k + 1), z.x, z.y - 58);
        const d = this.doors[k];
        ctx.strokeStyle = U.shade(owner(players, k).color, 0.3);
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 10]);
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - 24);
        ctx.lineTo(d.x, z.y + 70);
        ctx.lineTo(z.x, z.y + 70);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawProp(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    if (p.kind === 'trailer') {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(-p.hl + 6, -p.hw + 7, p.hl * 2, p.hw * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.hl, -p.hw, p.hl * 2, p.hw * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let x = -p.hl + 10; x < p.hl; x += 11) {
        ctx.beginPath(); ctx.moveTo(x, -p.hw); ctx.lineTo(x, p.hw); ctx.stroke();
      }
      ctx.fillStyle = '#444';
      ctx.fillRect(p.hl - 6, -4, 10, 8);
    } else if (p.kind === 'booth') {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(-p.hl + 5, -p.hw + 6, p.hl * 2, p.hw * 2);
      ctx.fillStyle = '#e7e1d3';
      ctx.fillRect(-p.hl, -p.hw, p.hl * 2, p.hw * 2);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(-p.hl, -p.hw, p.hl * 2, 8);
      ctx.fillStyle = '#9fd3f0';
      ctx.fillRect(-p.hl + 6, -2, p.hl * 2 - 12, 8);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(5, 6, p.hl, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#f0c419';
      ctx.beginPath(); ctx.arc(0, 0, p.hl, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(0, 0, p.hl * 0.45, 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }

  TR.Lot = Lot;
})();
