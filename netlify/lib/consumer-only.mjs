// The consumer functions serve the consumer user pool only.
// A token from a company tenant carries firebase.tenant and is refused.
export const consumerOnly = (verify) => async (token) => {
  const user = await verify(token);
  if (!user || (user.firebase && user.firebase.tenant)) throw new Error('not a consumer account');
  return user;
};
