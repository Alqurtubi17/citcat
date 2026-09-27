import asyncio
from twikit import Client

async def main():
    try:
        client = Client('id')
        print("Client twikit berhasil diinisialisasi.")
        # Menguji pencarian publik tanpa login (jika didukung) atau simulasi struktur
        tweets = await client.search_tweet('qiroah syamsuri firdaus', product='Top')
        for tweet in tweets[:3]:
            print(f"User: {tweet.user.name} (@{tweet.user.screen_name})")
            print(f"Tweet: {tweet.text}")
            print("-" * 30)
    except Exception as e:
        print(f"Terjadi kendala saat eksekusi: {e}")

asyncio.run(main())