# myi - Music Insights & Intelligence

A comprehensive Node.js web application that leverages the Spotify Web API to provide deep insights into your music listening habits. As a passionate music enthusiast, this project was born from a desire to better understand my own musical journey and discover new dimensions of my listening patterns.

## About

myi (Music Insights & Intelligence) transforms your Spotify listening data into beautiful, interactive visualizations and actionable insights. From discovering your listening patterns to creating mood-based playlists, this application helps you explore your musical identity in ways that go beyond simple play counts.

## Features

### Core Features

- **Listening Insights Dashboard**: Comprehensive visualization of your listening patterns including time-of-day analysis, genre distribution, discovery vs comfort ratios, and weekly listening heatmaps
- **Top Tracks**: View your most played songs across different time periods (4 weeks, 6 months, all time) with detailed statistics
- **Top Artists**: Explore your favorite artists with their most popular tracks and genre information
- **Smart Playlist Creator**: Automatically categorize your liked songs into three mood-based playlists:
  - **Energetic Vibes**: High energy, positive songs (valence > 0.6 AND energy > 0.6)
  - **Mellow Tunes**: Balanced, moderate energy songs
  - **Chill Vibes**: Low energy, relaxing songs (valence < 0.4 AND energy < 0.5)

### Advanced Features

- **Discovery vs Comfort Ratio**: Analyzes your recent listening to determine how much you're exploring new music versus sticking to familiar favorites
- **Weekly Listening Heatmap**: Visual representation of your listening patterns across days of the week (Work in Progress)
- **Artist Deep Dive**: Discover how much of your favorite artists' discographies you've explored and find missing tracks (Work in Progress)

## Tech Stack

- **Backend**: Node.js, Express.js
- **Authentication**: Passport.js with Spotify OAuth 2.0
- **Frontend**: EJS templating engine, Chart.js for visualizations
- **API**: Spotify Web API
- **Styling**: Custom CSS with bronze-themed design system

## Installation

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Spotify account
- Spotify Developer account

### Setup Instructions

1. **Clone the repository:**
```bash
git clone https://github.com/mohamedibrahim847/Spotify-App.git
cd Spotify-App
```

2. **Install dependencies:**
```bash
npm install
```

3. **Create a Spotify Developer App:**
   - Navigate to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Click "Create an App"
   - Fill in app details (name, description)
   - Add `http://localhost:3000/callback` to Redirect URIs
   - Save your Client ID and Client Secret

4. **Configure environment variables:**
   
   Create a `.env` file in the root directory:
```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
CALLBACK_URL=http://localhost:3000/callback
SESSION_SECRET=your_random_secret_string_here
PORT=3000
NODE_ENV=development
```

   Generate a secure session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

5. **Start the server:**
```bash
npm start
```

   For development with auto-restart:
```bash
npm run dev
```

6. **Access the application:**
   Open your browser and navigate to `http://localhost:3000`

## Project Structure

```
Spotify-App/
├── app.js                    # Main server file with routes and business logic
├── package.json              # Dependencies and npm scripts
├── .env                      # Environment variables (DO NOT COMMIT)
├── .gitignore               # Git ignore configuration
├── README.md                 # Project documentation
├── public/
│   ├── index.html           # Login/landing page
│   └── style.css            # Global stylesheet
└── views/                    # EJS templates
    ├── main-menu.ejs        # Main navigation menu
    ├── dashboard.ejs        # Listening insights dashboard
    ├── top-tracks.ejs       # Top tracks page
    ├── top-artists.ejs      # Top artists page
    ├── artist-dive.ejs      # Artist deep dive page (WIP)
    ├── error.ejs            # Error page template
    ├── shared-header.ejs    # Reusable header component
    └── bronze-styles.ejs    # Bronze theme styles
```

## Features in Detail

### Playlist Creator

The playlist creator analyzes your liked songs using Spotify's audio features API:

- **Valence**: Musical positiveness (0.0 to 1.0) - how positive/happy the track sounds
- **Energy**: Intensity and activity (0.0 to 1.0) - how energetic and fast-paced the track is

**Categorization Logic:**
- **Energetic**: valence > 0.6 AND energy > 0.6
- **Chill**: valence < 0.4 AND energy < 0.5
- **Mellow**: All other tracks

### Rate Limiting & Performance

The application implements sophisticated rate limiting and batch processing:

- Audio features fetched in batches of 50 tracks per request
- Artist data fetched in batches of 50 per request
- Tracks added to playlists in batches of 50
- Request queue system limits concurrent API calls to 5
- Automatic retry logic with exponential backoff for rate limit errors (429)
- Token refresh handling for 403 errors
- Maximum processing limit of 2000 songs for very large libraries

This architecture reduces API calls from potentially thousands to manageable batches, ensuring reliable performance even for users with extensive music libraries.

### Authentication & Security

- OAuth 2.0 authentication via Passport.js
- Automatic token refresh before expiration
- Secure session management with httpOnly cookies
- Environment variable validation on startup
- Input sanitization for playlist names

**Required Spotify Scopes:**
- `user-read-email`
- `user-read-private`
- `user-top-read`
- `playlist-modify-public`
- `user-read-recently-played`
- `playlist-modify-private`
- `user-library-read`

### Discovery vs Comfort Analysis

This feature compares your recently played tracks against your top tracks and top artists to determine:
- **Comfort tracks**: Songs that appear in both your recent plays and your top tracks/artists
- **Discovery tracks**: New music you're exploring

The analysis provides insights into your listening behavior, helping you understand whether you're in a discovery phase or sticking to familiar favorites.

## Work in Progress

The following features are currently under active development:

- **Weekly Listening Heatmap**: Enhanced day-based visualization with improved interactivity and insights
- **Artist Deep Dive**: Complete implementation of artist coverage analysis and playlist generation for missing tracks

## Troubleshooting

### "Error fetching data"
- Verify your access token hasn't expired (the app auto-refreshes tokens)
- Ensure your Spotify Developer App has the correct redirect URI configured
- Check that all required environment variables are set in your `.env` file
- Verify your Spotify account has sufficient listening history

### Playlist creation fails
- Ensure you have liked songs in your Spotify library
- Verify your app has all required scopes (permissions) in the Spotify Developer Dashboard
- For users with 1000+ liked songs, playlist creation may take several minutes
- Check browser console for specific error messages

### Rate limiting errors
- The application handles rate limits automatically with retry logic
- If you encounter persistent rate limiting, wait a few minutes before retrying
- Very large libraries may require multiple attempts for playlist creation

### Authentication issues
- Clear your browser cookies and try logging in again
- Verify your redirect URI matches exactly in both `.env` and Spotify Developer Dashboard
- Ensure your session secret is properly configured

## Development

### Running in Development Mode

```bash
npm run dev
```

This uses nodemon to automatically restart the server on file changes.

### Code Structure

- **Routes**: Defined in `app.js` with clear separation of concerns
- **Helper Functions**: Modular functions for playlist creation, data analysis, and API interactions
- **Error Handling**: Comprehensive error handling with user-friendly messages
- **Rate Limiting**: Built-in request queue and retry mechanisms

## Contributing

Contributions are welcome! Please feel free to:
- Open issues for bugs or feature requests
- Submit pull requests with improvements
- Provide feedback on user experience

## License

ISC

## Author

**Mohamed Ibrahim**

As a huge music fan, this project represents my passion for both music and technology. The desire to understand my own listening patterns and discover new ways to interact with my music collection inspired the creation of myi. I hope it helps you explore your musical journey as much as it has helped me explore mine.
