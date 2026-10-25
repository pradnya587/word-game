import RoomScreen from '@/components/room/RoomScreen'

export const metadata = { title: 'Room — wordRoyale' }

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <RoomScreen code={code} />
}
