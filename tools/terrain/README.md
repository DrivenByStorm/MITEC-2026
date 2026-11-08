# Terrain fetch

Downloads real elevation data for the site and writes `services/edge/data/site-dem.json`, which the edge service loads. Run it once on a computer with internet; the site itself never needs a connection.

```bash
cd tools/terrain
npm install
npm run fetch                                            # default site in Pecos County, TX
npm run fetch -- --lat 30.79 --lon -103.03 --size-km 6 --cell 15
npm run fetch -- --tiles-dir ./my-tiles                  # tiles already on disk (z/x/y.png)
```

Source: AWS Terrain Tiles (Terrarium), derived from USGS 3DEP (about 10 m resolution in the US). Commit the resulting file to share it with the team.
