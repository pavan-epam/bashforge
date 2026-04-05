import type { FileTab } from '../types'

interface FileTabsBarProps {
  tabs:          FileTab[]
  activeId:      string | null
  onActivate:    (id: string) => void
  onClose:       (id: string) => void
}

function fileIcon(name: string): string {
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return '⚡'
  if (name.endsWith('.txt')) return '📄'
  return '📄'
}

export function FileTabsBar({ tabs, activeId, onActivate, onClose }: FileTabsBarProps) {
  if (tabs.length === 0) {
    return (
      <div className="file-tabs-bar" style={{ paddingLeft: 12, alignItems: 'center' }}>
        <span style={{ color: 'var(--fg-comment)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
          No files open — click New or Open
        </span>
      </div>
    )
  }
  return (
    <div className="file-tabs-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`file-tab${tab.id === activeId ? ' active' : ''}${tab.modified ? ' modified' : ''}`}
          role="tab"
          aria-selected={tab.id === activeId}
          onClick={() => onActivate(tab.id)}
          title={tab.path}
        >
          <span style={{ fontSize: 11 }}>{fileIcon(tab.name)}</span>
          <span>{tab.name}</span>
          <button
            className="file-tab-close"
            onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
            title="Close tab"
            aria-label={`Close ${tab.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
