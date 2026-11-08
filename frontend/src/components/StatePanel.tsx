import { useState } from 'react'
import type { Asset, AssetRequest, TwinSnapshot } from '../twin/types'
import { ageSeconds, formatAge, freshness } from '../twin/freshness'
import type { Act } from '../edge/client'

interface Props {
  snapshot: TwinSnapshot
  selectedId?: string
  onSelect: (id: string | undefined) => void
  act: Act
}

const TABS = ['Overview', 'Machines', 'People', 'Network', 'Requests', 'Activity'] as const
type Tab = (typeof TABS)[number]

export function StatePanel({ snapshot, selectedId, onSelect, act }: Props) {
  const [tab, setTab] = useState<Tab>('Overview')
  const selected = snapshot.assets.find((a) => a.id === selectedId)

  return (
    <aside className="panel" aria-label="Live site state">
      {selected && <AssetDetail asset={selected} snapshot={snapshot} onClose={() => onSelect(undefined)} act={act} />}

      <div className="tabs" role="tablist" aria-label="Site state views">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t}
            {t === 'Requests' && <Count n={snapshot.requests.filter((r) => !['done', 'cancelled'].includes(r.status)).length} />}
            {t === 'Network' && <Count n={snapshot.assets.filter((a) => a.kind === 'relay' && relayDown(a, snapshot.now)).length} alert />}
          </button>
        ))}
      </div>

      <div className="panel__body" role="tabpanel">
        {tab === 'Overview' && <Overview snapshot={snapshot} onSelect={onSelect} />}
        {tab === 'Machines' && (
          <AssetTable
            assets={snapshot.assets.filter((a) => a.kind === 'robot' || a.kind === 'machine' || a.kind === 'drone')}
            now={snapshot.now}
            selectedId={selectedId}
            onSelect={onSelect}
            columns="machines"
          />
        )}
        {tab === 'People' && (
          <AssetTable assets={snapshot.assets.filter((a) => a.kind === 'worker')} now={snapshot.now} selectedId={selectedId} onSelect={onSelect} columns="people" />
        )}
        {tab === 'Network' && <Network snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} />}
        {tab === 'Requests' && <Requests requests={snapshot.requests} target={firstRow(snapshot)} onSelect={onSelect} act={act} />}
        {tab === 'Activity' && <Activity snapshot={snapshot} onSelect={onSelect} />}
      </div>
    </aside>
  )
}

function Count({ n, alert }: { n: number; alert?: boolean }) {
  if (!n) return null
  return <span className={`count ${alert ? 'count--alert' : ''}`}>{n}</span>
}

function relayDown(a: Asset, now: number) {
  return a.mode === 'offline' || freshness(a.lastHeard, now) !== 'live'
}

function Fresh({ a, now }: { a: Asset; now: number }) {
  const f = freshness(a.lastHeard, now)
  return (
    <span className={`fresh fresh--${f}`}>
      <span className="fresh__dot" aria-hidden="true" />
      {formatAge(ageSeconds(a.lastHeard, now))}
    </span>
  )
}

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <span className={`meter ${value < 25 ? 'meter--low' : ''}`} title={`${label} ${value}%`}>
      <span className="meter__fill" style={{ width: `${value}%` }} />
      <span className="meter__text">{value}%</span>
    </span>
  )
}

function AssetDetail({ asset: a, snapshot, onClose, act }: { asset: Asset; snapshot: TwinSnapshot; onClose: () => void; act: Act }) {
  const machine = a.kind === 'robot' || a.kind === 'machine' || a.kind === 'drone'
  return (
    <section className="detail" aria-label={`${a.name} details`}>
      <div className="detail__head">
        <div>
          <h2 className="detail__name">{a.name}</h2>
          <p className="detail__role">{a.role}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Clear selection">×</button>
      </div>
      <dl className="detail__grid">
        {a.kind !== 'worker' && (
          <>
            <dt>Doing</dt>
            <dd>{a.task}</dd>
            <dt>Mode</dt>
            <dd className={`mode mode--${a.mode}`}>{a.mode}</dd>
          </>
        )}
        <dt>Last heard</dt>
        <dd><Fresh a={a} now={snapshot.now} /></dd>
        <dt>Link</dt>
        <dd>{a.link === 'none' ? 'Out of coverage' : `${a.link === 'lora' ? 'LoRa' : 'Mesh'}${a.via ? ` via ${a.via}` : ''}`}</dd>
        <dt>{a.kind === 'worker' ? 'Tag battery' : a.kind === 'machine' ? 'Fuel' : 'Battery'}</dt>
        <dd><Meter value={a.energy} label="Energy" /></dd>
        <dt>Position</dt>
        <dd>{Math.round(a.x)} m E, {Math.round(a.y)} m S</dd>
      </dl>
      {machine && (
        <div className="detail__actions">
          {a.mode === 'paused' ? (
            <button type="button" className="btn" onClick={() => act('twin.resume', { id: a.id })}>Resume {a.name}</button>
          ) : (
            <button type="button" className="btn btn--stop" onClick={() => act('twin.pause', { id: a.id })}>Pause {a.name}</button>
          )}
        </div>
      )}
    </section>
  )
}

function Overview({ snapshot, onSelect }: { snapshot: TwinSnapshot; onSelect: (id: string) => void }) {
  const total = snapshot.units.length
  const installed = snapshot.units.filter((u) => u.status === 'installed').length
  const relays = snapshot.assets.filter((a) => a.kind === 'relay')
  const down = relays.filter((r) => relayDown(r, snapshot.now))
  const nonRelay = snapshot.assets.filter((a) => a.kind !== 'relay')
  const stale = nonRelay.filter((a) => freshness(a.lastHeard, snapshot.now) === 'stale')
  const alerts = snapshot.events.filter((e) => e.level !== 'info').slice(0, 5)

  return (
    <div className="overview">
      <section>
        <h3 className="section-title">Build progress</h3>
        <p className="big-figure">
          {installed} <span className="big-figure__of">of {total} P3 units set</span>
        </p>
        <ul className="blocks">
          {snapshot.blocks.map((b) => {
            const us = snapshot.units.filter((u) => u.block === b.id)
            const set = us.filter((u) => u.status === 'installed').length
            const piled = us.filter((u) => u.status === 'piled').length
            return (
              <li key={b.id} className="block-row">
                <span className="block-row__name">Block {b.id}</span>
                <span className="stack" aria-label={`${set} set, ${piled} foundations ready, ${us.length - set - piled} planned`}>
                  <span className="stack__set" style={{ width: `${(set / us.length) * 100}%` }} />
                  <span className="stack__piled" style={{ width: `${(piled / us.length) * 100}%` }} />
                </span>
                <span className="block-row__num">{Math.round((set / us.length) * 100)}%</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="vitals">
        <div>
          <span className="vital__num">{nonRelay.filter((a) => a.kind === 'worker').length}</span>
          <span className="vital__label">people on site</span>
        </div>
        <div>
          <span className="vital__num">{nonRelay.filter((a) => a.kind !== 'worker').length}</span>
          <span className="vital__label">robots and machines</span>
        </div>
        <div className={down.length ? 'vital--warn' : ''}>
          <span className="vital__num">{relays.length - down.length}/{relays.length}</span>
          <span className="vital__label">relays up</span>
        </div>
        <div className={stale.length ? 'vital--warn' : ''}>
          <span className="vital__num">{stale.length}</span>
          <span className="vital__label">not heard 30 s+</span>
        </div>
      </section>

      {stale.length > 0 && (
        <section>
          <h3 className="section-title">Out of touch</h3>
          <p className="hint">Shown at their last reported position. They keep working and sync when back in coverage.</p>
          <ul className="chips">
            {stale.map((a) => (
              <li key={a.id}>
                <button type="button" className="chip" onClick={() => onSelect(a.id)}>
                  {a.name}, {formatAge(ageSeconds(a.lastHeard, snapshot.now))}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="section-title">Needs attention</h3>
        {alerts.length === 0 ? (
          <p className="hint">Nothing right now.</p>
        ) : (
          <ul className="events">
            {alerts.map((e) => (
              <li key={e.id} className={`event event--${e.level}`}>
                <time>{clock(e.at)}</time>
                <button type="button" className="event__text" onClick={() => e.assetId && onSelect(e.assetId)}>{e.text}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function AssetTable({ assets, now, selectedId, onSelect, columns }: { assets: Asset[]; now: number; selectedId?: string; onSelect: (id: string) => void; columns: 'machines' | 'people' }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">{columns === 'machines' ? 'Doing' : 'Role'}</th>
          <th scope="col">{columns === 'machines' ? 'Fuel / battery' : 'Tag'}</th>
          <th scope="col">Last heard</th>
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => (
          <tr key={a.id} className={a.id === selectedId ? 'is-selected' : ''} onClick={() => onSelect(a.id)}>
            <th scope="row">
              <button type="button" className="row-btn" onClick={() => onSelect(a.id)}>{a.name}</button>
              {columns === 'machines' && <span className={`mode mode--${a.mode}`}>{a.mode}</span>}
            </th>
            <td>{columns === 'machines' ? a.task : a.role}</td>
            <td><Meter value={a.energy} label="Energy" /></td>
            <td><Fresh a={a} now={now} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Network({ snapshot, selectedId, onSelect }: { snapshot: TwinSnapshot; selectedId?: string; onSelect: (id: string) => void }) {
  const relays = snapshot.assets.filter((a) => a.kind === 'relay')
  const dark = snapshot.assets.filter((a) => a.kind !== 'relay' && a.kind !== 'worker' && a.link === 'none')
  const linkCount = (id: string) => snapshot.links.filter((l) => l.a === id || l.b === id).length
  return (
    <div className="network">
      <ul className="net-summary">
        <li>
          <span className={`dot ${snapshot.edgeServer.online ? 'dot--ok' : 'dot--bad'}`} /> Edge server {snapshot.edgeServer.online ? 'running' : 'down'}
        </li>
        <li>
          <span className={`dot ${snapshot.uplink.online ? 'dot--ok' : 'dot--idle'}`} /> Satellite uplink {snapshot.uplink.online ? 'up' : 'down'}, last HQ sync {formatAge(ageSeconds(snapshot.uplink.lastSync, snapshot.now))}
        </li>
        <li>
          <span className="dot dot--ok" /> {snapshot.links.length} mesh links active
        </li>
      </ul>
      {dark.length > 0 && (
        <p className="hint hint--warn">
          Out of coverage, working offline: {dark.map((d) => d.name).join(', ')}
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Relay</th>
            <th scope="col">Status</th>
            <th scope="col">Links</th>
            <th scope="col">Battery</th>
            <th scope="col">Last heard</th>
          </tr>
        </thead>
        <tbody>
          {relays.map((r) => {
            const down = relayDown(r, snapshot.now)
            return (
              <tr key={r.id} className={r.id === selectedId ? 'is-selected' : ''} onClick={() => onSelect(r.id)}>
                <th scope="row"><button type="button" className="row-btn" onClick={() => onSelect(r.id)}>{r.name}</button></th>
                <td className={down ? 'text-alert' : ''}>{down ? 'No heartbeat' : 'Relaying'}</td>
                <td>{down ? '–' : linkCount(r.id)}</td>
                <td><Meter value={r.energy} label="Battery" /></td>
                <td><Fresh a={r} now={snapshot.now} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const STEPS: AssetRequest['status'][] = ['pending', 'assigned', 'en-route', 'arrived', 'done']

function Requests({ requests, target, onSelect, act }: { requests: AssetRequest[]; target: string; onSelect: (id: string) => void; act: Act }) {
  if (!requests.length) {
    return (
      <div className="empty">
        <p>No equipment requests yet.</p>
        <button type="button" className="btn" onClick={() => act('twin.request', { need: 'telehandler', target })}>Request a telehandler at {target}</button>
      </div>
    )
  }
  return (
    <ol className="requests">
      {requests.map((r) => {
        const step = STEPS.indexOf(r.status)
        return (
          <li key={r.id} className={`request request--${r.status}`}>
            <div className="request__head">
              <strong>{r.id}</strong> {r.need} at {r.target.label}
            </div>
            <div className="request__meta">
              {r.assignedTo ? (
                <button type="button" className="link-btn" onClick={() => onSelect(r.assignedTo!)}>{r.assignedTo}</button>
              ) : (
                'Unassigned'
              )}
              {r.status === 'en-route' && r.eta != null && <>, about {r.eta} s away</>}
              {r.status === 'cancelled' && <>, cancelled</>}
            </div>
            {r.status !== 'cancelled' && (
              <ol className="steps" aria-label={`Status: ${r.status}`}>
                {STEPS.map((s, i) => (
                  <li key={s} className={i <= step ? 'is-done' : ''}>{s.replace('-', ' ')}</li>
                ))}
              </ol>
            )}
            {!['done', 'cancelled'].includes(r.status) && (
              <button type="button" className="link-btn" onClick={() => act('twin.cancelRequest', { id: r.id })}>Cancel</button>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Activity({ snapshot, onSelect }: { snapshot: TwinSnapshot; onSelect: (id: string) => void }) {
  return (
    <ul className="events events--full">
      {snapshot.events.slice(0, 120).map((e) => (
        <li key={e.id} className={`event event--${e.level}`}>
          <time>{clock(e.at)}</time>
          <button type="button" className="event__text" onClick={() => e.assetId && onSelect(e.assetId)}>{e.text}</button>
        </li>
      ))}
    </ul>
  )
}

function clock(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
}

/** A real place to offer in the "request a telehandler" example: row 1 of the first block. */
function firstRow(s: TwinSnapshot) {
  const b = s.blocks[0]?.id ?? 'A'
  const row = s.units.find((u) => u.block === b)?.row ?? 1
  return `${b}${row}`
}
