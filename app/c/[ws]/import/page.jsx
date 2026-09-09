'use client';

import { Suspense, use } from 'react';
import { useSearchParams } from 'next/navigation';
import LocalAssetImport from '../../../components/LocalAssetImport';

export default function ImportPage({ params }) {
  return <Suspense><ImportDestination params={params} /></Suspense>;
}

function ImportDestination({ params }) {
  const { ws } = use(params);
  const search = useSearchParams();
  const firstCrew = search.get('firstCrew');
  const continuation = firstCrew && /^[a-zA-Z0-9_-]+$/.test(firstCrew)
    ? `/c/${encodeURIComponent(ws)}/crew/${encodeURIComponent(firstCrew)}` : `/c/${encodeURIComponent(ws)}`;
  return <div style={{ maxWidth: 820, width: '100%', margin: '0 auto' }}><LocalAssetImport key={ws} ws={ws} continuation={continuation} /></div>;
}
