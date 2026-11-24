

PORT=3000
MONGO_URI=<tavo url>
retryWrites=true&w=majority
JWT_SECRET=<tavo slaptazodis>
CLIENT_ORIGIN=http://localhost:5173


GET /users
Grąžina visų naudotojų sąrašą, išrikiuotą pagal _id didėjančia tvarka.

Prieiga / Teisės: Tik administratoriams (requireAdmin middleware).

Užklausos parametrai: Nėra.

Atsakymo formatas (200 OK): JSON masyvas su supaprastintais naudotojo objektais (be slaptazodis lauko).

Atsakymo pavyzdys (200 OK):

JSON
[
  {
    "id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "vardas": "Jonas",
    "role": "admin",
    "uzblokuotas": false
  },
  {
    "id": "65f1a2b3c4d5e6f7a8b9c0d2",
    "vardas": "Asta",
    "role": "user",
    "uzblokuotas": true
  }
]
