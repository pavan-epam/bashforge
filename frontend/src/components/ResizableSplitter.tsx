import { useCallback, useEffect, useRef, useState } from 'react'

interface ResizableSplitterProps {
  direction: 'horizontal' | 'vertical'
  onDelta:   (delta: number) => void
}

export function ResizableSplitter({ direction, onDelta }: ResizableSplitterProps) {
  const [dragging, setDragging] = useState(false)
  const lastPos = useRef(0)
  const onDeltaRef = useRef(onDelta)
  onDeltaRef.current = onDelta

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
  }, [direction])

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: MouseEvent) => {
      const pos   = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = pos - lastPos.current
      lastPos.current = pos
      onDeltaRef.current(delta)
    }
    const onUp = () => setDragging(false)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [dragging, direction])

  return (
    <div
      className={`splitter ${direction}${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
      title="Drag to resize"
    />
  )
}
