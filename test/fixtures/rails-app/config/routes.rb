Rails.application.routes.draw do
  root to: "pages#home"

  get "/about", to: "pages#about", as: :about
  get "/contact", to: "pages#contact"

  resources :users do
    member do
      get :follow
      delete :unfollow
    end
    collection do
      get :search
    end
    resources :posts, only: [:index, :show, :create]
  end

  resource :session, only: [:new, :create, :destroy]

  namespace :admin do
    resources :users
    resources :posts do
      member { post :publish }
    end
  end

  scope path: "/v1", module: "api" do
    resources :widgets
  end

  draw :marketing
end
