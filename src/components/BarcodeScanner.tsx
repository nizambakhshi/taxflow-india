'use client'

import { useEffect, useRef, useState } from 'react'
import { cameraScanSupported, createDetector, detectFromVideo, type BarcodeDetectorLike } from '@/lib/barcode'

interface Props {
  onScan: (code: string) => void
  onClose: () => void
  label?: string
}

export default function BarcodeScanner({ onScan, onClose, label = 'Point the camera at a barcode' }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const firedRef = useRef(false)
  const lastCodeRef = useRef('')

  const [status, setStatus] = useState<'starting' | 'scanning' | 'error'>('starting')
  const [message, setMessage] = useState('Requesting camera…')

  useEffect(() => {
    if (!cameraScanSupported()) {
      setStatus('error')
      setMessage('This browser cannot decode barcodes with its camera. Chrome, Edge and Android browser support it; on iPhone use the manual field.')
      return
    }

    const detector = createDetector()
    if (!detector) {
      setStatus('error')
      setMessage('Barcode detection is unavailable in this browser.')
      return
    }

    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    async function start(detector: BarcodeDetectorLike) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }
        setStatus('scanning')
        setMessage('Scanning…')

        timer = setInterval(async () => {
          if (!videoRef.current || firedRef.current) return
          const found = await detectFromVideo(videoRef.current, detector)
          if (!found) return
          // Ignore a repeated read of the same code
          if (found.value === lastCodeRef.current) return
          lastCodeRef.current = found.value
          firedRef.current = true
          onScan(found.value)
        }, 250)
      } catch (err: any) {
        if (cancelled) return
        setStatus('error')
        setMessage(
          err?.name === 'NotAllowedError'
            ? 'Camera permission was blocked. Allow it in your browser settings, or type the barcode instead.'
            : 'Could not start the camera. Check that a camera is available, or type the barcode instead.'
        )
      }
    }

    start(detector)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [onScan])

  return (
    <div style={{
      background: '#0f172a', borderRadius: '12px', padding: '12px', marginTop: '10px'
    }}>
      <div style={{ position: 'relative', overflow: 'hidden', borderRadius: '8px' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: '100%', display: 'block',
            aspectRatio: '4 / 3', objectFit: 'cover',
            background: '#1e293b',
            opacity: status === 'scanning' ? 1 : 0.25
          }}
        />
        {/* Framing guide */}
        {status === 'scanning' && (
          <div style={{
            position: 'absolute', left: '10%', right: '10%', top: '28%', bottom: '28%',
            border: '2px dashed rgba(255,255,255,0.8)', borderRadius: '8px',
            boxShadow: '0 0 0 9999px rgba(15,23,42,0.35)'
          }} />
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', marginTop: '10px'
      }}>
        <div style={{ fontSize: '12px', color: status === 'error' ? '#fca5a5' : '#cbd5e1' }}>
          {status === 'scanning' ? label : message}
        </div>
        <button
          onClick={onClose}
          style={{
            padding: '6px 14px', background: 'rgba(255,255,255,0.12)',
            color: 'white', border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: '7px', fontSize: '12px', fontWeight: '500', cursor: 'pointer',
            whiteSpace: 'nowrap'
          }}
        >
          {status === 'error' ? 'Close' : 'Stop camera'}
        </button>
      </div>
    </div>
  )
}
