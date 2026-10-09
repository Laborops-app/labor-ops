'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, Me } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api<{ user: Me }>('/api/auth/me')
      .then(({ user }) => router.replace(user.role === 'crew' ? '/my-shifts' : '/dashboard'))
      .catch(() => router.replace('/login'));
  }, [router]);
  return <div className="center muted">Loading…</div>;
}
